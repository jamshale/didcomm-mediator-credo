import { describe, expect, it, vi } from "vitest";

import {
  CredoMediatorCleanUp,
  type AskarRecord,
  type AskarStore,
  type AskarStoreFactory,
  type AskarTransaction,
  formatUtcDatetime,
  getConnectionActivityTime,
} from "../src/credoMediatorCleanUp.js";

class FakeTxn implements AskarTransaction {
  public readonly removed: Array<[string, string]> = [];
  public readonly replaced: Array<{
    category: string;
    name: string;
    valueJson: Record<string, unknown>;
    tags?: Record<string, string> | null;
  }> = [];
  public committed = false;
  public rolledBack = false;

  public constructor(
    private readonly recordLookup: Record<string, AskarRecord[]> = {},
    private readonly connectionRecords: AskarRecord[] = [],
  ) {}

  public async fetchAll(
    category: string,
    options?: { tagFilter?: Record<string, string>; limit?: number },
  ): Promise<AskarRecord[]> {
    if (category === "ConnectionRecord" && !options?.tagFilter) {
      return this.connectionRecords;
    }

    const key = JSON.stringify({ category, tagFilter: options?.tagFilter ?? {} });
    return this.recordLookup[key] ?? [];
  }

  public async remove(category: string, name: string): Promise<void> {
    this.removed.push([category, name]);
  }

  public async replace(options: {
    category: string;
    name: string;
    valueJson: Record<string, unknown>;
    tags?: Record<string, string> | null;
  }): Promise<void> {
    this.replaced.push(options);
  }

  public async commit(): Promise<void> {
    this.committed = true;
  }

  public async rollback(): Promise<void> {
    this.rolledBack = true;
  }
}

class FakeStore implements AskarStore {
  public closed = false;

  public constructor(private readonly transactions: AskarTransaction[]) {}

  public async withTransaction<T>(callback: (txn: AskarTransaction) => Promise<T>): Promise<T> {
    const txn = this.transactions.shift();
    if (!txn) {
      throw new Error("No transaction available");
    }

    return callback(txn);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeStoreFactory implements AskarStoreFactory {
  public constructor(private readonly store: AskarStore) {}

  public async open(): Promise<AskarStore> {
    return this.store;
  }
}

describe("getConnectionActivityTime", () => {
  it("prefers lastSeen from tags", () => {
    const activityTime = getConnectionActivityTime(
      {
        updatedAt: "2026-03-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
      },
      { lastSeen: "2026-03-24T20:27:09.902Z" },
    );

    expect(activityTime?.toISOString()).toBe("2026-03-24T20:27:09.902Z");
  });

  it("accepts non-utc offsets", () => {
    const activityTime = getConnectionActivityTime(
      {
        updatedAt: "2026-03-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
      },
      { lastSeen: "2026-03-24T22:27:09.902+02:00" },
    );

    expect(activityTime?.toISOString()).toBe("2026-03-24T20:27:09.902Z");
  });

  it("falls back to updatedAt", () => {
    const activityTime = getConnectionActivityTime({
      updatedAt: "2026-03-01T00:00:00Z",
      createdAt: "2026-02-01T00:00:00Z",
    });

    expect(activityTime?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("falls back to createdAt", () => {
    const activityTime = getConnectionActivityTime({ createdAt: "2026-02-01T00:00:00" });

    expect(activityTime?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("falls back to valueJson tags", () => {
    const activityTime = getConnectionActivityTime({
      _tags: { lastSeen: "2026-03-24T20:27:09.902Z" },
      updatedAt: "2026-03-01T00:00:00Z",
    });

    expect(activityTime?.toISOString()).toBe("2026-03-24T20:27:09.902Z");
  });

  it("returns null without timestamps", () => {
    expect(getConnectionActivityTime({})).toBeNull();
  });
});

describe("CredoMediatorCleanUp", () => {
  it("deletes stale connections and related records", async () => {
    const connectionRecord: AskarRecord = {
      name: "conn-1",
      valueJson: {
        theirDid: "their-did",
        did: "my-did",
        updatedAt: "2000-01-01T00:00:00Z",
      },
      tags: {},
    };
    const txn = new FakeTxn(
      {
        [lookupKey("DidRecord", { did: "their-did" })]: [{ name: "did-2", valueJson: {} }],
        [lookupKey("DidRecord", { did: "my-did" })]: [{ name: "did-1", valueJson: {} }],
        [lookupKey("MediationRecord", { connectionId: "conn-1" })]: [
          { name: "mediation-1", valueJson: {} },
        ],
        [lookupKey("PushNotificationsFcmRecord", { connectionId: "conn-1" })]: [
          { name: "firebase-1", valueJson: {} },
        ],
      },
      [],
    );
    const session = new FakeTxn({}, [connectionRecord]);
    const store = new FakeStore([session, txn]);
    const connect = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ rows: [] }));
    const walletConnect = vi.fn(async () => undefined);
    const walletClose = vi.fn(async () => undefined);

    const cleanup = new CredoMediatorCleanUp({
      conn: { uri: "sqlite:///wallet.db", connect: walletConnect, close: walletClose },
      pickupRepoConn: {
        parsedUrl: {
          hostname: "localhost",
          port: 5432,
          username: "user",
          password: "pass",
          path: "/db",
        },
      },
      walletName: "wallet",
      walletKey: "key",
      inactiveDaysThreshold: 365,
      storeFactory: new FakeStoreFactory(store),
      pgClientFactory: () => ({ connect, query, end }),
      logger: { log: vi.fn(), error: vi.fn() },
    });

    await cleanup.cleanup();

    expect(txn.removed).toEqual([
      ["ConnectionRecord", "conn-1"],
      ["DidRecord", "did-2"],
      ["DidRecord", "did-1"],
      ["MediationRecord", "mediation-1"],
      ["PushNotificationsFcmRecord", "firebase-1"],
    ]);
    expect(txn.committed).toBe(true);
    expect(store.closed).toBe(true);
    expect(walletClose).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("skips queued connections", async () => {
    const connectionRecord: AskarRecord = {
      name: "conn-queued",
      valueJson: { updatedAt: "2000-01-01T00:00:00Z" },
      tags: {},
    };
    const txn = new FakeTxn();
    const session = new FakeTxn({}, [connectionRecord]);
    const store = new FakeStore([session, txn]);
    const query = vi.fn(async () => ({ rows: [{ connection_id: "conn-queued" }] }));
    const walletClose = vi.fn(async () => undefined);

    const cleanup = new CredoMediatorCleanUp({
      conn: { uri: "sqlite:///wallet.db", connect: vi.fn(async () => undefined), close: walletClose },
      pickupRepoConn: { parsedUrl: { path: "/db" } },
      walletName: "wallet",
      walletKey: "key",
      storeFactory: new FakeStoreFactory(store),
      pgClientFactory: () => ({ connect: vi.fn(async () => undefined), query, end: vi.fn(async () => undefined) }),
      logger: { log: vi.fn(), error: vi.fn() },
    });

    await cleanup.cleanup();

    expect(txn.removed).toEqual([]);
    expect(txn.committed).toBe(false);
    expect(txn.rolledBack).toBe(false);
    expect(store.closed).toBe(true);
    expect(walletClose).toHaveBeenCalledOnce();
  });

  it("backfills updatedAt when timestamps are missing", async () => {
    const connectionRecord: AskarRecord = { name: "conn-1", valueJson: {}, tags: {} };
    const txn = new FakeTxn();
    const session = new FakeTxn({}, [connectionRecord]);
    const store = new FakeStore([session, txn]);
    const now = new Date("2026-04-06T12:00:00Z");
    const walletClose = vi.fn(async () => undefined);

    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const cleanup = new CredoMediatorCleanUp({
        conn: { uri: "sqlite:///wallet.db", connect: vi.fn(async () => undefined), close: walletClose },
        pickupRepoConn: { parsedUrl: { path: "/db" } },
        walletName: "wallet",
        walletKey: "key",
        storeFactory: new FakeStoreFactory(store),
        pgClientFactory: () => ({ connect: vi.fn(async () => undefined), query: vi.fn(async () => ({ rows: [] })), end: vi.fn(async () => undefined) }),
        logger: { log: vi.fn(), error: vi.fn() },
      });

      await cleanup.cleanup();

      expect(txn.removed).toEqual([]);
      expect(txn.replaced).toEqual([
        {
          category: "ConnectionRecord",
          name: "conn-1",
          valueJson: { updatedAt: formatUtcDatetime(now) },
          tags: {},
        },
      ]);
      expect(txn.committed).toBe(true);
      expect(store.closed).toBe(true);
      expect(walletClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

function lookupKey(category: string, tagFilter: Record<string, string>): string {
  return JSON.stringify({ category, tagFilter });
}