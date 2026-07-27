import sql from "mssql";

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
  return globalThis.pulseShowDemoData === true;
}

// The switch CONTENT repositories use (requests, ideas, releases, triage,
// analytics, search, taxonomy, comments, drafts, links). With "Show demo data"
// enabled they serve the in-memory demo seed instead of Azure SQL — writes go
// to memory too (ephemeral by design; single instance). Identity, authorization,
// user/org administration, settings, tours, chat, MCP, and workers deliberately
// keep using isAzureSqlConfigured() directly: who you are and what you may do
// must never come from demo data.
export function isContentSqlActive() {
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
  globalThis.pulseSqlPool ||= new sql.ConnectionPool(config).connect();
  return globalThis.pulseSqlPool;
}

export { sql };
