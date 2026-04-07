import { fileURLToPath } from "node:url";

import { createAskarNodeJsStoreFactory } from "./askarNodeJsAdapter.js";
import {
  CredoMediatorCleanUp,
  type CredoMediatorCleanUpOptions,
  type PickupRepositoryConnection,
  type WalletConnection,
} from "./credoMediatorCleanUp.js";

export function buildCredoMediatorCleanUpOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CredoMediatorCleanUpOptions {
  const walletUri = requireEnv(env, "WALLET_URI");
  const pickupRepositoryUrl = requireAnyEnv(env, ["PICKUP_REPOSITORY_URL", "DATABASE_URL", "POSTGRES_URL"]);

  return {
    conn: createWalletConnection(walletUri),
    pickupRepoConn: parsePickupRepositoryUrl(pickupRepositoryUrl),
    walletName: requireEnv(env, "WALLET_NAME"),
    walletKey: requireEnv(env, "WALLET_KEY"),
    walletKeyDerivationMethod: env.WALLET_KEY_DERIVATION_METHOD,
    inactiveDaysThreshold: parseOptionalNumber(env.INACTIVE_DAYS_THRESHOLD, "INACTIVE_DAYS_THRESHOLD"),
  };
}

export async function runCleanupFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const cleanup = new CredoMediatorCleanUp({
    ...buildCredoMediatorCleanUpOptionsFromEnv(env),
    storeFactory: createAskarNodeJsStoreFactory(),
  });

  await cleanup.cleanup();
}

export function parsePickupRepositoryUrl(value: string): PickupRepositoryConnection {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error("PICKUP_REPOSITORY_URL must be a valid postgres connection URL");
  }

  return {
    parsedUrl: {
      hostname: parsedUrl.hostname || undefined,
      port: parsedUrl.port ? Number(parsedUrl.port) : undefined,
      username: parsedUrl.username ? decodeURIComponent(parsedUrl.username) : undefined,
      password: parsedUrl.password ? decodeURIComponent(parsedUrl.password) : undefined,
      path: parsedUrl.pathname,
    },
  };
}

function createWalletConnection(uri: string): WalletConnection {
  return {
    uri,
    connect: async () => undefined,
    close: async () => undefined,
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function requireAnyEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }

  throw new Error(`Missing required environment variable: one of ${names.join(", ")}`);
}

function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }

  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCleanupFromEnv().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}