import { KdfMethod, Store, StoreKeyMethod, } from "@openwallet-foundation/askar-nodejs";
export function createAskarNodeJsStoreFactory() {
    return {
        async open({ uri, passKey, keyMethod }) {
            const store = await Store.open({
                uri,
                passKey,
                keyMethod: toStoreKeyMethod(keyMethod),
            });
            return {
                async withTransaction(callback) {
                    const session = await store.transaction().open();
                    const transaction = new NodeJsAskarTransaction(session);
                    return callback(transaction);
                },
                async close() {
                    await store.close();
                },
            };
        },
    };
}
class NodeJsAskarTransaction {
    session;
    constructor(session) {
        this.session = session;
    }
    async fetchAll(category, options) {
        const entries = await this.session.fetchAll({
            category,
            tagFilter: options?.tagFilter,
            limit: options?.limit,
            isJson: true,
        });
        return entries.map((entry) => ({
            name: entry.name,
            valueJson: asRecord(entry.value),
            tags: normalizeTags(entry.tags),
        }));
    }
    async remove(category, name) {
        await this.session.remove({ category, name });
    }
    async replace(options) {
        await this.session.replace({
            category: options.category,
            name: options.name,
            value: options.valueJson,
            tags: options.tags ?? undefined,
        });
    }
    async commit() {
        await this.session.commit();
    }
    async rollback() {
        await this.session.rollback();
    }
}
export function toStoreKeyMethod(value) {
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
function asRecord(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    throw new Error("Expected JSON object entry value from Askar session");
}
function normalizeTags(value) {
    return Object.fromEntries(Object.entries(value ?? {}).map(([key, entryValue]) => [key, String(entryValue)]));
}
