import { createHash } from "node:crypto";
import type { PulseIdentity } from "@/lib/domain";
import { atomicSql, getSqlPool, isAzureSqlConfigured, sql } from "./database";
import {
  requireInternalRole,
  requireMembership,
  requirePublishRole,
} from "./authorization";
import { getRequest } from "./request-repository";
import { readJson } from "./validation";

type Entry = {
  hash: string;
  expires: number;
  result: { body: unknown; status: number } | null;
};
declare global {
  var pulseMemoryIdempotency: Map<string, Entry> | undefined;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function authorize(identity: PulseIdentity, operation: string) {
  await requireMembership(identity);
  if (/^(idea\.|release\.|triage\.)/.test(operation))
    await requirePublishRole(identity);
  if (operation.startsWith("webhook-"))
    await requireInternalRole(identity, ["System admin"]);
  if (operation.startsWith("saved-view.")) await requireInternalRole(identity);
  if (/^(attachment|comment)\.create:/.test(operation))
    await getRequest(identity, operation.split(":")[1]);
}

/** Authorization precedes both lookup and work. SQL work and response commit together. */
export async function executeIdempotent<T>(
  request: Request,
  identity: PulseIdentity,
  operation: string,
  status: number,
  work: () => Promise<T>,
) {
  await authorize(identity, operation);
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || !/^[A-Za-z0-9._:-]{8,100}$/.test(key))
    throw new Error("INVALID_IDEMPOTENCY_KEY");
  const payload = request.body ? await readJson(request.clone()) : null;
  const hash = digest(
    canonicalJson({
      method: request.method,
      path: new URL(request.url).pathname,
      payload,
      version: request.headers.get("if-match"),
    }),
  );
  const organizationId = identity.organizationId;
  const compound = `${organizationId}:${identity.id}:${operation}:${key}`;
  if (!isAzureSqlConfigured()) {
    const memory = (globalThis.pulseMemoryIdempotency ||= new Map());
    for (const [k, v] of memory)
      if (v.expires <= Date.now() && v.result) memory.delete(k);
    const old = memory.get(compound);
    if (old) {
      if (old.hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
      if (!old.result) throw new Error("IDEMPOTENCY_IN_PROGRESS");
      return {
        body: old.result.body as T,
        status: old.result.status,
        replayed: true,
      };
    }
    if (memory.size >= 5000) throw new Error("RATE_LIMITED");
    memory.set(compound, {
      hash,
      expires: Date.now() + 86_400_000,
      result: null,
    });
    try {
      const body = await work();
      memory.get(compound)!.result = { body: structuredClone(body), status };
      return { body, status, replayed: false };
    } catch (error) {
      memory.delete(compound);
      throw error;
    }
  }
  return atomicSql(async () => {
    const pool = await getSqlPool();
    const locked = await pool
      .request()
      .input("resource", sql.NVarChar(255), `idempotency:${digest(compound)}`)
      .query(
        "DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=0; SELECT @r result",
      );
    if (locked.recordset[0].result < 0)
      throw new Error("IDEMPOTENCY_IN_PROGRESS");
    await authorize(identity, operation);
    const bind = () =>
      pool
        .request()
        .input("org", sql.NVarChar(32), organizationId)
        .input("user", sql.UniqueIdentifier, identity.id)
        .input("key", sql.NVarChar(100), key)
        .input("op", sql.NVarChar(100), operation);
    await bind().query(
      "DELETE dbo.IdempotencyKeys WHERE organization_id=@org AND user_id=@user AND idempotency_key=@key AND operation=@op AND expires_at<=SYSUTCDATETIME()",
    );
    const previous = await bind().query(
      "SELECT request_hash hash,response_json body,response_status status FROM dbo.IdempotencyKeys WHERE organization_id=@org AND user_id=@user AND idempotency_key=@key AND operation=@op",
    );
    if (previous.recordset.length) {
      const old = previous.recordset[0];
      if (old.hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
      if (!old.body) throw new Error("IDEMPOTENCY_IN_PROGRESS");
      return {
        body: JSON.parse(old.body) as T,
        status: old.status as number,
        replayed: true,
      };
    }
    const body = await work();
    await bind()
      .input("hash", sql.Char(64), hash)
      .input("body", sql.NVarChar(sql.MAX), JSON.stringify(body))
      .input("status", sql.Int, status)
      .query(
        "INSERT dbo.IdempotencyKeys(organization_id,user_id,idempotency_key,operation,request_hash,response_json,response_status,expires_at) VALUES(@org,@user,@key,@op,@hash,@body,@status,DATEADD(hour,24,SYSUTCDATETIME()))",
      );
    return { body, status, replayed: false };
  });
}
