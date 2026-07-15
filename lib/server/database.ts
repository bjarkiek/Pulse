import sql from "mssql";

declare global {
  var pulseSqlPool: Promise<sql.ConnectionPool> | undefined;
}

export function isAzureSqlConfigured() {
  return Boolean(
    process.env.AZURE_SQL_CONNECTION_STRING || process.env.AZURE_SQL_SERVER,
  );
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
