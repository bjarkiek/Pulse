// Email one-time-passcode sign-in: code issuance and verification.
//
// Security posture: 6-digit codes, hashed at rest (sha256 of email:code —
// brute force is bounded by the attempt cap, not hash strength), 10-minute
// TTL, 5 verification attempts, at most 3 issuances per e-mail per 15 minutes,
// single active code (a fresh issue invalidates the previous one), single use.
// Who MAY sign in this way is decided by resolveUserForOtp (user-directory):
// only Active users designated authentication = "OTP".
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 3;

export type OtpVerdict = "ok" | "invalid" | "expired" | "too_many_attempts";

declare global {
  // email -> single active code + issuance history for the rate limit
  var pulseMemoryOtpCodes:
    | Record<string, { hash: string; expiresAt: number; attempts: number; issued: number[] }>
    | undefined;
}

function codeHash(email: string, code: string): string {
  return createHash("sha256").update(`${email.toLowerCase()}:${code}`, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function issueOtpCode(email: string): Promise<{ code: string }> {
  const normalized = email.trim().toLowerCase();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = Date.now();

  if (!isAzureSqlConfigured()) {
    globalThis.pulseMemoryOtpCodes ||= {};
    const existing = globalThis.pulseMemoryOtpCodes[normalized];
    const issued = (existing?.issued ?? []).filter((at) => at > now - RATE_WINDOW_MS);
    if (issued.length >= RATE_MAX) throw new Error("RATE_LIMITED");
    issued.push(now);
    globalThis.pulseMemoryOtpCodes[normalized] = {
      hash: codeHash(normalized, code), expiresAt: now + TTL_MS, attempts: 0, issued,
    };
    return { code };
  }

  const pool = await getSqlPool();
  const recent = await pool.request()
    .input("email", sql.NVarChar(320), normalized)
    .query(
      "SELECT COUNT(1) issued FROM dbo.OtpCodes WHERE email=@email AND created_at > DATEADD(minute,-15,SYSUTCDATETIME())",
    );
  if (recent.recordset[0].issued >= RATE_MAX) throw new Error("RATE_LIMITED");
  await pool.request()
    .input("id", sql.UniqueIdentifier, crypto.randomUUID())
    .input("email", sql.NVarChar(320), normalized)
    .input("hash", sql.NVarChar(64), codeHash(normalized, code))
    .input("expiresAt", sql.DateTime2, new Date(now + TTL_MS))
    .query(
      // invalidate any previous active code, insert the new one, sweep old rows
      "UPDATE dbo.OtpCodes SET consumed_at=SYSUTCDATETIME() WHERE email=@email AND consumed_at IS NULL;" +
      "INSERT dbo.OtpCodes(id,email,code_hash,expires_at) VALUES(@id,@email,@hash,@expiresAt);" +
      "DELETE FROM dbo.OtpCodes WHERE created_at < DATEADD(day,-1,SYSUTCDATETIME());",
    );
  return { code };
}

export async function verifyOtpCode(email: string, code: string): Promise<OtpVerdict> {
  const normalized = email.trim().toLowerCase();
  const now = Date.now();

  if (!isAzureSqlConfigured()) {
    const entry = globalThis.pulseMemoryOtpCodes?.[normalized];
    if (!entry) return "invalid";
    if (entry.expiresAt <= now) return "expired";
    if (entry.attempts >= MAX_ATTEMPTS) return "too_many_attempts";
    if (!hashesEqual(entry.hash, codeHash(normalized, code))) {
      entry.attempts += 1;
      return "invalid";
    }
    delete globalThis.pulseMemoryOtpCodes![normalized];
    return "ok";
  }

  const pool = await getSqlPool();
  const row = (
    await pool.request()
      .input("email", sql.NVarChar(320), normalized)
      .query(
        "SELECT TOP(1) CAST(id AS nvarchar(36)) id, code_hash codeHash, attempts, expires_at expiresAt FROM dbo.OtpCodes WHERE email=@email AND consumed_at IS NULL ORDER BY created_at DESC",
      )
  ).recordset[0];
  if (!row) return "invalid";
  if (new Date(row.expiresAt).getTime() <= now) return "expired";
  if (row.attempts >= MAX_ATTEMPTS) return "too_many_attempts";
  if (!hashesEqual(row.codeHash, codeHash(normalized, code))) {
    await pool.request()
      .input("id", sql.UniqueIdentifier, row.id)
      .query("UPDATE dbo.OtpCodes SET attempts = attempts + 1 WHERE id=@id");
    return "invalid";
  }
  await pool.request()
    .input("id", sql.UniqueIdentifier, row.id)
    .query("UPDATE dbo.OtpCodes SET consumed_at=SYSUTCDATETIME() WHERE id=@id");
  return "ok";
}
