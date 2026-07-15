import type { PulseIdentity } from "@/lib/domain";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

type StoredResult = { body: unknown; status: number };
type PendingResult = StoredResult | null;

declare global {
  var pulseMemoryIdempotency: Map<string, PendingResult> | undefined;
}

function memory() {
  globalThis.pulseMemoryIdempotency ||= new Map();
  return globalThis.pulseMemoryIdempotency;
}

function readKey(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (
    !key ||
    key.length < 8 ||
    key.length > 100 ||
    !/^[A-Za-z0-9._:-]+$/.test(key)
  )
    throw new Error("INVALID_IDEMPOTENCY_KEY");
  return key;
}

export async function executeIdempotent<T>(
  request: Request,
  identity: PulseIdentity,
  operation: string,
  status: number,
  work: () => Promise<T>,
): Promise<{ body: T; status: number; replayed: boolean }> {
  const idempotencyKey = readKey(request);
  const compound = `${identity.organizationId}:${operation}:${idempotencyKey}`;
  if (!isAzureSqlConfigured()) {
    if (memory().has(compound)) {
      const stored = memory().get(compound);
      if (!stored) throw new Error("IDEMPOTENCY_IN_PROGRESS");
      return { body: stored.body as T, status: stored.status, replayed: true };
    }
    memory().set(compound, null);
    try {
      const body = await work();
      memory().set(compound, { body, status });
      return { body, status, replayed: false };
    } catch (error) {
      memory().delete(compound);
      throw error;
    }
  }

  const pool = await getSqlPool();
  const find = async () =>
    pool
      .request()
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("key", sql.NVarChar(100), idempotencyKey)
      .input("operation", sql.NVarChar(100), operation)
      .query(
        "SELECT response_status status,response_json body FROM dbo.IdempotencyKeys WHERE organization_id=@organizationId AND idempotency_key=@key AND operation=@operation AND expires_at>SYSUTCDATETIME()",
      );
  const existing = await find();
  if (existing.recordset.length) {
    const row = existing.recordset[0];
    if (!row.body) throw new Error("IDEMPOTENCY_IN_PROGRESS");
    return { body: JSON.parse(row.body), status: row.status, replayed: true };
  }
  try {
    await pool
      .request()
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("key", sql.NVarChar(100), idempotencyKey)
      .input("operation", sql.NVarChar(100), operation)
      .query(
        "INSERT dbo.IdempotencyKeys(organization_id,idempotency_key,operation,expires_at) VALUES(@organizationId,@key,@operation,DATEADD(hour,24,SYSUTCDATETIME()))",
      );
  } catch {
    const raced = await find();
    if (raced.recordset[0]?.body)
      return {
        body: JSON.parse(raced.recordset[0].body),
        status: raced.recordset[0].status,
        replayed: true,
      };
    throw new Error("IDEMPOTENCY_IN_PROGRESS");
  }
  try {
    const body = await work();
    await pool
      .request()
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("key", sql.NVarChar(100), idempotencyKey)
      .input("operation", sql.NVarChar(100), operation)
      .input("status", sql.Int, status)
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(body))
      .query(
        "UPDATE dbo.IdempotencyKeys SET response_status=@status,response_json=@body WHERE organization_id=@organizationId AND idempotency_key=@key AND operation=@operation",
      );
    return { body, status, replayed: false };
  } catch (error) {
    await pool
      .request()
      .input("organizationId", sql.NVarChar(32), identity.organizationId)
      .input("key", sql.NVarChar(100), idempotencyKey)
      .input("operation", sql.NVarChar(100), operation)
      .query(
        "DELETE dbo.IdempotencyKeys WHERE organization_id=@organizationId AND idempotency_key=@key AND operation=@operation AND response_json IS NULL",
      );
    throw error;
  }
}
