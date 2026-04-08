# Credo Mediator Cleanup TypeScript Port

This project is a TypeScript port of the logic in `askar_tools/credo_mediator_clean_up.py`.

Current scope:

- Preserves connection staleness logic.
- Preserves `lastSeen`/`updatedAt`/`createdAt` timestamp selection.
- Preserves queued-message protection.
- Preserves deletion of related DID, mediation, and Firebase records.
- Includes a concrete `@openwallet-foundation/askar-nodejs` store adapter.

For the most accurate cleanup behavior, mediation connection records should be tagged with a `lastSeen` timestamp. If `lastSeen` is not present, the cleanup process falls back to `updatedAt`, and then to `createdAt`.

The current cleanup implementation is best-effort, not atomic per connection. It uses session-backed writes instead of a single rollback-capable transaction for each connection record. If a failure happens partway through removing related records, some changes may already have been applied and the next scheduled run is expected to finish any remaining cleanup.

Scheduling is expected to be handled externally, for example with an OpenShift CronJob.

The cleanup class can be used directly with the included OWF adapter:

```ts
import { CredoMediatorCleanUp, createAskarNodeJsStoreFactory } from "./src/index.js";

const cleanup = new CredoMediatorCleanUp({
	conn,
	pickupRepoConn,
	walletName: "wallet",
	walletKey: "secret",
	walletKeyDerivationMethod: "ARGON2I_MOD",
	storeFactory: createAskarNodeJsStoreFactory(),
});

await cleanup.cleanup();
```

The package can also run as a process using environment variables:

```bash
export WALLET_URI='sqlite:///wallet.db'
export PICKUP_REPOSITORY_URL='postgres://user:pass@localhost:5432/db'
export WALLET_NAME='wallet'
export WALLET_KEY='secret'
export WALLET_KEY_DERIVATION_METHOD='ARGON2I_MOD'
export INACTIVE_DAYS_THRESHOLD='365'

pnpm start
```

Supported environment variables:

- `WALLET_URI`: required Askar wallet URI.
- `PICKUP_REPOSITORY_URL`: required Postgres connection URL for the queued message table. `DATABASE_URL` and `POSTGRES_URL` are also accepted.
- `WALLET_NAME`: required wallet name.
- `WALLET_KEY`: required wallet key.
- `WALLET_KEY_DERIVATION_METHOD`: optional wallet key derivation method.
- `INACTIVE_DAYS_THRESHOLD`: optional number of inactive days before a connection is deleted.

## OpenShift CronJob Example

An example monthly OpenShift CronJob manifest is available in `openshift-cronjob.example.yaml`.

The example runs once a month at `03:00` UTC on the first day of the month and starts the cleanup process with `pnpm start`.

## Docker

Container examples are available in `Dockerfile` and `docker-compose.yml`.

Build the cleanup image from the repository root:

```bash
docker build -f apps/clean_up/Dockerfile -t credo-mediator-cleanup .
```

Run it with Docker Compose:

```bash
cd apps/clean_up
docker compose up --build
```

The compose example injects the cleanup configuration through environment variables.

## Commands

```bash
pnpm install
pnpm test
pnpm build
```

If pnpm blocks native dependency install scripts on a fresh machine, run `pnpm approve-builds` and approve `@openwallet-foundation/askar-nodejs`, `esbuild`, and `koffi`.