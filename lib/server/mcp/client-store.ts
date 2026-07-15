import { getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { randomToken } from "./crypto";

export type McpClientRecord = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
};

declare global {
  var pulseMemoryMcpClients: Map<string, McpClientRecord> | undefined;
}

function memoryClients(): Map<string, McpClientRecord> {
  globalThis.pulseMemoryMcpClients ||= new Map();
  return globalThis.pulseMemoryMcpClients;
}

// ---------------------------------------------------------------------------
// createMcpClient / getMcpClient
// ---------------------------------------------------------------------------

export async function createMcpClient(
  clientName: string,
  redirectUris: string[],
): Promise<McpClientRecord> {
  const record: McpClientRecord = {
    clientId: randomToken(16),
    clientName,
    redirectUris,
    createdAt: new Date().toISOString(),
  };
  if (!isAzureSqlConfigured()) {
    memoryClients().set(record.clientId, record);
    return record;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, crypto.randomUUID())
    .input("clientId", sql.NVarChar(64), record.clientId)
    .input("clientName", sql.NVarChar(200), record.clientName)
    .input("redirectUrisJson", sql.NVarChar(sql.MAX), JSON.stringify(record.redirectUris))
    .query(
      "INSERT INTO dbo.McpClients (id, client_id, client_name, redirect_uris_json) VALUES (@id, @clientId, @clientName, @redirectUrisJson)",
    );
  return record;
}

export async function getMcpClient(clientId: string): Promise<McpClientRecord | null> {
  if (!isAzureSqlConfigured()) return memoryClients().get(clientId) ?? null;
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("clientId", sql.NVarChar(64), clientId)
    .query(
      "SELECT client_id clientId, client_name clientName, redirect_uris_json redirectUrisJson, created_at createdAt FROM dbo.McpClients WHERE client_id=@clientId",
    );
  const row = result.recordset[0];
  if (!row) return null;
  return {
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUris: JSON.parse(row.redirectUrisJson),
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// isAllowedRedirectUri
// ---------------------------------------------------------------------------

// RFC 8252 §7.3 native-app redirect policy: https anywhere; http only to the
// loopback interface (dev tooling); any other scheme is treated as a
// private-use native-app scheme (e.g. "myapp://cb") and allowed. Fragments
// are rejected outright (RFC 6749 §3.1.2 forbids them in redirect URIs).
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopbackHost(url.hostname);
  // Strip the trailing colon the WHATWG URL parser leaves on `protocol` (e.g. "myapp:").
  const scheme = url.protocol.slice(0, -1);
  return scheme.length > 1;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}
