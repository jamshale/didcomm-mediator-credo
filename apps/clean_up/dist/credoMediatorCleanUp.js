import { Client } from "pg";
const defaultLogger = {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
};
export function parseIsoDatetime(value) {
    const normalized = hasExplicitOffset(value) ? value : `${value}+00:00`;
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid ISO datetime: ${value}`);
    }
    return parsed;
}
export function formatUtcDatetime(value) {
    return value.toISOString();
}
export function getConnectionActivityTime(connectionValue, connectionTags) {
    const nestedTags = asRecord(connectionValue._tags);
    const lastSeenTime = connectionTags?.lastSeen ?? asString(nestedTags?.lastSeen);
    if (lastSeenTime) {
        return parseIsoDatetime(lastSeenTime);
    }
    const updatedAt = asString(connectionValue.updatedAt);
    if (updatedAt) {
        return parseIsoDatetime(updatedAt);
    }
    const createdAt = asString(connectionValue.createdAt);
    if (createdAt) {
        return parseIsoDatetime(createdAt);
    }
    return null;
}
export class CredoMediatorCleanUp {
    conn;
    pickupRepoConn;
    walletName;
    walletKey;
    walletKeyDerivationMethod;
    inactiveDaysThreshold;
    storeFactory;
    pgClientFactory;
    logger;
    constructor(options) {
        this.conn = options.conn;
        this.pickupRepoConn = options.pickupRepoConn;
        this.walletName = options.walletName;
        this.walletKey = options.walletKey;
        this.walletKeyDerivationMethod = options.walletKeyDerivationMethod ?? "ARGON2I_MOD";
        this.inactiveDaysThreshold = options.inactiveDaysThreshold ?? 365;
        this.storeFactory = options.storeFactory ?? missingStoreFactory();
        this.pgClientFactory = options.pgClientFactory ?? ((config) => new Client(config));
        this.logger = options.logger ?? defaultLogger;
    }
    async cleanup() {
        this.logger.log("Cleaning up wallet...");
        const now = new Date();
        const store = await this.storeFactory.open({
            uri: this.conn.uri,
            passKey: this.walletKey,
            keyMethod: this.walletKeyDerivationMethod,
        });
        const dbConn = this.pgClientFactory({
            host: this.pickupRepoConn.parsedUrl.hostname ?? undefined,
            port: this.pickupRepoConn.parsedUrl.port ?? 5432,
            user: this.pickupRepoConn.parsedUrl.username ?? undefined,
            password: this.pickupRepoConn.parsedUrl.password ?? undefined,
            database: this.pickupRepoConn.parsedUrl.path.replace(/^\//, ""),
        });
        try {
            await dbConn.connect();
            await this.conn.connect();
            const queuedResult = await dbConn.query("SELECT DISTINCT connection_id FROM queued_message");
            const connectionsWithQueuedMessages = new Set(queuedResult.rows.map((row) => String(row.connection_id)));
            const connectionRecords = await store.withTransaction((txn) => txn.fetchAll("ConnectionRecord"));
            let deleted = 0;
            for (const connectionRecord of connectionRecords) {
                await store.withTransaction(async (txn) => {
                    try {
                        if (connectionsWithQueuedMessages.has(connectionRecord.name)) {
                            this.logger.log(`Skipping connection record with id ${connectionRecord.name} because it has queued messages`);
                            return;
                        }
                        const activityTime = getConnectionActivityTime(connectionRecord.valueJson, connectionRecord.tags);
                        if (!activityTime) {
                            const connectionValue = { ...connectionRecord.valueJson, updatedAt: formatUtcDatetime(now) };
                            await txn.replace({
                                category: "ConnectionRecord",
                                name: connectionRecord.name,
                                valueJson: connectionValue,
                                tags: connectionRecord.tags,
                            });
                            this.logger.log(`Backfilled updatedAt for connection record with id ${connectionRecord.name} to ${String(connectionValue.updatedAt)}`);
                            await txn.commit();
                            return;
                        }
                        const inactivityMs = this.inactiveDaysThreshold * 24 * 60 * 60 * 1000;
                        if (now.getTime() - activityTime.getTime() > inactivityMs) {
                            const theirDid = asString(connectionRecord.valueJson.theirDid);
                            const did = asString(connectionRecord.valueJson.did);
                            await txn.remove("ConnectionRecord", connectionRecord.name);
                            if (theirDid) {
                                const theirDidRecord = await txn.fetchAll("DidRecord", {
                                    tagFilter: { did: theirDid },
                                    limit: 1,
                                });
                                if (theirDidRecord[0]) {
                                    await txn.remove("DidRecord", theirDidRecord[0].name);
                                }
                            }
                            if (did) {
                                const didRecord = await txn.fetchAll("DidRecord", {
                                    tagFilter: { did },
                                    limit: 1,
                                });
                                if (didRecord[0]) {
                                    await txn.remove("DidRecord", didRecord[0].name);
                                }
                            }
                            const mediationRecord = await txn.fetchAll("MediationRecord", {
                                tagFilter: { connectionId: connectionRecord.name },
                                limit: 1,
                            });
                            if (mediationRecord[0]) {
                                await txn.remove("MediationRecord", mediationRecord[0].name);
                            }
                            const firebaseRecord = await txn.fetchAll("PushNotificationsFcmRecord", {
                                tagFilter: { connectionId: connectionRecord.name },
                                limit: 1,
                            });
                            if (firebaseRecord[0]) {
                                await txn.remove("PushNotificationsFcmRecord", firebaseRecord[0].name);
                            }
                            deleted += 1;
                            this.logger.log(`Deleted connection record with id ${connectionRecord.name} last active at ${activityTime.toISOString()} and associated records`);
                        }
                        await txn.commit();
                    }
                    catch (error) {
                        this.logger.error(`Error processing connection record with id ${connectionRecord.name}: ${formatError(error)}`);
                        await txn.rollback();
                    }
                });
            }
            this.logger.log(`Cleanup complete. Deleted ${deleted} connection and related records.`);
        }
        finally {
            await store.close();
            await this.conn.close();
            await dbConn.end();
        }
    }
}
function missingStoreFactory() {
    return {
        async open() {
            throw new Error("No Askar store factory provided. Use createAskarNodeJsStoreFactory() or inject a test double.");
        },
    };
}
function hasExplicitOffset(value) {
    return /(Z|[+-]\d{2}:\d{2})$/i.test(value);
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function asRecord(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return undefined;
}
function formatError(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
