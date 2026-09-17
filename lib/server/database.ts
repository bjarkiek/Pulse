import sql from "mssql";
import { AsyncLocalStorage } from "node:async_hooks";
import { requireLocalAdapter } from "./production-config";

const transactions = new AsyncLocalStorage<sql.Transaction>();

declare global {
  var pulseSqlPool: Promise<sql.ConnectionPool> | undefined;
  // "Show demo data" runtime cache. Stamped by settings-repository on every
  // read/save of the system settings and primed at boot (instrumentation-node),
  // so the sync content-path switch below never needs a DB round-trip.
  var pulseShowDemoData: boolean | undefined;
}

export function isAzureSqlConfigured() {
  return Boolean(
    process.env.AZURE_SQL_CONNECTION_STRING || process.env.AZURE_SQL_SERVER,
  );
}

export function isDemoDataActive() {
  return (
    process.env.NODE_ENV !== "production" &&
    globalThis.pulseShowDemoData === true
  );
}

// The switch CONTENT repositories use (requests, ideas, releases, triage,
// analytics, search, taxonomy, comments, drafts, links). With "Show demo data"
// enabled they serve the in-memory demo seed instead of Azure SQL — writes go
// to memory too (ephemeral by design; single instance). Identity, authorization,
// user/org administration, settings, tours, chat, MCP, and workers deliberately
// keep using isAzureSqlConfigured() directly: who you are and what you may do
// must never come from demo data.
export function isContentSqlActive() {
  if (!isAzureSqlConfigured()) requireLocalAdapter();
  return isAzureSqlConfigured() && !isDemoDataActive();
}

export async function getSqlPool() {
  const connectionString = process.env.AZURE_SQL_CONNECTION_STRING;
  const server = process.env.AZURE_SQL_SERVER;
  const database = process.env.AZURE_SQL_DATABASE || "Pulse";
  if (!connectionString && !server) throw new Error("AZURE_SQL_NOT_CONFIGURED");
  const config: string | sql.config = connectionString || {
    server: server!,
    database,
    port: 1433,
    authentication: {
      type: "azure-active-directory-msi-app-service",
      options: {},
    },
    options: { encrypt: true, trustServerCertificate: false },
    pool: { min: 0, max: 20, idleTimeoutMillis: 30_000 },
  };
  globalThis.pulseSqlPool ||= new sql.ConnectionPool(config)
    .connect()
    .catch((error) => {
      globalThis.pulseSqlPool = undefined;
      throw error;
    });
  const pool = await globalThis.pulseSqlPool;
  const active = transactions.getStore();
  // Every repository request joins the current unit of work, including reads.
  return active
    ? new Proxy(pool, {
        get(target, key) {
          if (key === "request") return () => new sql.Request(active);
          return Reflect.get(target, key);
        },
      })
    : pool;
}

export async function beginSqlTransaction(pool: sql.ConnectionPool) {
  const active = transactions.getStore();
  const transaction = active || new sql.Transaction(pool);
  if (!active) await transaction.begin();
  return {
    transaction,
    commit: async () => {
      if (!active) await transaction.commit();
    },
    rollback: async () => {
      if (!active) await transaction.rollback();
    },
  };
}

export async function atomicSql<T>(work: () => Promise<T>): Promise<T> {
  if (transactions.getStore()) return work();
  const transaction = new sql.Transaction(await getSqlPool());
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await transactions.run(transaction, work);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
}

export { sql };
