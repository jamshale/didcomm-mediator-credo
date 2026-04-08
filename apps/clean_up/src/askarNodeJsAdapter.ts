import {
  KdfMethod,
  type Session,
  Store,
  StoreKeyMethod,
  type EntryObject,
} from "@openwallet-foundation/askar-nodejs";

import type {
  AskarRecord,
  AskarSession,
  AskarStore,
  AskarStoreFactory,
  AskarTransaction,
} from "./credoMediatorCleanUp.js";

export function createAskarNodeJsStoreFactory(): AskarStoreFactory {
  return {
    async open({ uri, passKey, keyMethod }): Promise<AskarStore> {
      const store = await Store.open({
        uri,
        passKey,
        keyMethod: toStoreKeyMethod(keyMethod),
      });

      return {
        async fetchAll(
          category: string,
          options?: { tagFilter?: Record<string, string>; limit?: number },
        ): Promise<AskarRecord[]> {
          const session = await store.session().open();

          try {
            const entries = await session.fetchAll({
              category,
              tagFilter: options?.tagFilter,
              limit: options?.limit,
              isJson: true,
            });

            return mapEntries(entries);
          } finally {
            if (session.handle) {
              await session.close();
            }
          }
        },
        async withSession<T>(callback: (session: AskarSession) => Promise<T>): Promise<T> {
          const session = await store.session().open();

          try {
            const askarSession = new NodeJsAskarSession(session);
            return await callback(askarSession);
          } finally {
            if (session.handle) {
              await session.close();
            }
          }
        },
        async withTransaction<T>(callback: (txn: AskarTransaction) => Promise<T>): Promise<T> {
          const session = await store.transaction().open();

          try {
            const transaction = new NodeJsAskarTransaction(session);
            return await callback(transaction);
          } catch (error) {
            if (session.handle) {
              await session.rollback();
            }

            throw error;
          } finally {
            if (session.handle) {
              await session.close();
            }
          }
        },
        async close(): Promise<void> {
          await store.close();
        },
      };
    },
  };
}

class NodeJsAskarSession implements AskarSession {
  public constructor(
    protected readonly session: Pick<Session, "fetchAll" | "remove" | "replace">,
  ) {}

  public async fetchAll(
    category: string,
    options?: { tagFilter?: Record<string, string>; limit?: number },
  ): Promise<AskarRecord[]> {
    const entries = await this.session.fetchAll({
      category,
      tagFilter: options?.tagFilter,
      limit: options?.limit,
      isJson: true,
    });

    return mapEntries(entries);
  }

  public async remove(category: string, name: string): Promise<void> {
    await this.session.remove({ category, name });
  }

  public async replace(options: {
    category: string;
    name: string;
    valueJson: Record<string, unknown>;
    tags?: Record<string, string> | null;
  }): Promise<void> {
    await this.session.replace({
      category: options.category,
      name: options.name,
      value: options.valueJson,
      tags: options.tags ?? undefined,
    });
  }
}

class NodeJsAskarTransaction extends NodeJsAskarSession implements AskarTransaction {
  public constructor(
    private readonly transactionSession: Pick<Session, "fetchAll" | "remove" | "replace" | "commit" | "rollback">,
  ) {
    super(transactionSession);
  }

  public async commit(): Promise<void> {
    await this.transactionSession.commit();
  }

  public async rollback(): Promise<void> {
    await this.transactionSession.rollback();
  }
}

function mapEntries(entries: EntryObject[]): AskarRecord[] {
  return entries.map((entry) => ({
    name: entry.name,
    valueJson: asRecord(entry.value),
    tags: normalizeTags(entry.tags),
  }));
}

export function toStoreKeyMethod(value?: string): StoreKeyMethod | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case "RAW":
      return new StoreKeyMethod(KdfMethod.Raw);
    case "NONE":
      return new StoreKeyMethod(KdfMethod.None);
    case "ARGON2I_INT":
    case "KDF:ARGON2I:INT":
      return new StoreKeyMethod(KdfMethod.Argon2IInt);
    case "ARGON2I_MOD":
    case "KDF:ARGON2I:MOD":
      return new StoreKeyMethod(KdfMethod.Argon2IMod);
    default:
      throw new Error(`Unsupported wallet key derivation method: ${value}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("Expected JSON object entry value from Askar session");
}

function normalizeTags(value: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([key, entryValue]) => [key, String(entryValue)]),
  );
}