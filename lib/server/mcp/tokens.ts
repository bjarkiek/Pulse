import { SignJWT, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
import { getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { randomToken, sha256Base64Url } from "./crypto";
import { users as memoryUsers, type UserRecord } from "@/lib/server/admin-repository";

export const MCP_ISSUER = "pulse";
export const MCP_AUDIENCE = "pulse-mcp";
export const ACCESS_TOKEN_SECONDS = 3600;
export const REFRESH_TOKEN_DAYS = 60;

export type McpAccessTokenClaims = {
  sub: string;
  email: string;
  name: string;
  clientId: string;
  exp: number;
};

type MemoryRefreshToken = {
  userId: string;
  clientId: string;
  expiresAt: number; // epoch ms
  revokedAt: number | null;
};

declare global {
  var pulseMemoryMcpRefreshTokens: Map<string, MemoryRefreshToken> | undefined;
  var pulseMcpEphemeralKey: Uint8Array | undefined;
}

function memoryRefreshTokens(): Map<string, MemoryRefreshToken> {
  globalThis.pulseMemoryMcpRefreshTokens ||= new Map();
  return globalThis.pulseMemoryMcpRefreshTokens;
}

function findMemoryUser(userId: string): UserRecord | undefined {
  return memoryUsers().find((u) => u.id === userId);
}

// ---------------------------------------------------------------------------
// Signing key
// ---------------------------------------------------------------------------

// Prefer a stable, operator-supplied key (base64, >=64 bytes) so tokens survive
// restarts/redeploys. Falls back to a per-process ephemeral key, memoized on
// globalThis so it survives dev hot-reload without being regenerated on every
// module re-evaluation — a WARNED, dev/uninitialized-prod-only posture.
function signingKey(): Uint8Array {
  const configured = process.env.MCP_TOKEN_SIGNING_KEY;
  if (configured) {
    const buf = Buffer.from(configured, "base64");
    if (buf.length >= 64) return buf;
  }
  if (!globalThis.pulseMcpEphemeralKey) {
    console.warn(
      "[mcp/tokens] MCP_TOKEN_SIGNING_KEY is not configured (or shorter than 64 bytes) — " +
        "using an ephemeral in-memory signing key. Issued MCP access/refresh tokens will not " +
        "survive a process restart. Set MCP_TOKEN_SIGNING_KEY (base64, >=64 bytes) in production.",
    );
    globalThis.pulseMcpEphemeralKey = randomBytes(64);
  }
  return globalThis.pulseMcpEphemeralKey;
}

// ---------------------------------------------------------------------------
// Access tokens — self-issued HS256 JWTs
// ---------------------------------------------------------------------------

export async function issueAccessToken(
  user: { id: string; email: string; name: string },
  clientId: string,
): Promise<string> {
  const key = signingKey();
  return new SignJWT({ email: user.email, name: user.name, client_id: clientId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setJti(randomToken(16))
    .setIssuedAt()
    .setNotBefore(new Date())
    .setExpirationTime(`${ACCESS_TOKEN_SECONDS}s`)
    .setIssuer(MCP_ISSUER)
    .setAudience(MCP_AUDIENCE)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<McpAccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: MCP_ISSUER,
      audience: MCP_AUDIENCE,
      algorithms: ["HS256"],
      clockTolerance: 60,
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.client_id !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      clientId: payload.client_id,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens — opaque, stored as SHA-256 hashes, rotated on every use
// ---------------------------------------------------------------------------

export async function createRefreshToken(userId: string, clientId: string): Promise<string> {
  const raw = randomToken(48);
  const tokenHash = sha256Base64Url(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

  if (!isAzureSqlConfigured()) {
    memoryRefreshTokens().set(tokenHash, {
      userId,
      clientId,
      expiresAt: expiresAt.getTime(),
      revokedAt: null,
    });
    return raw;
  }

  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, crypto.randomUUID())
    .input("tokenHash", sql.NVarChar(64), tokenHash)
    .input("userId", sql.UniqueIdentifier, userId)
    .input("clientId", sql.NVarChar(64), clientId)
    .input("expiresAt", sql.DateTime2, expiresAt)
    .query(
      "INSERT INTO dbo.McpRefreshTokens (id, token_hash, user_id, client_id, expires_at) VALUES (@id, @tokenHash, @userId, @clientId, @expiresAt)",
    );
  return raw;
}

// Atomic single-use rotation: the token is revoked (claimed) in the SAME
// statement/step that validates it, so two concurrent redeems of the same raw
// token can't both succeed, and a wrong-client redeem never revokes the token
// (client_id is inside the claim predicate, not checked afterward).
export async function redeemRefreshToken(rawToken: string, clientId: string): Promise<string | null> {
  const tokenHash = sha256Base64Url(rawToken);
  if (!isAzureSqlConfigured()) return redeemRefreshTokenMemory(tokenHash, clientId);
  return redeemRefreshTokenSql(tokenHash, clientId);
}

function redeemRefreshTokenMemory(tokenHash: string, clientId: string): string | null {
  const record = memoryRefreshTokens().get(tokenHash);
  // Single synchronous predicate check mirroring the SQL WHERE clause exactly
  // (token + client + not-revoked + not-expired) — Node's single-threaded
  // event loop means nothing can interleave between this check and the
  // revocation write below, so this is the atomic claim.
  if (!record || record.clientId !== clientId || record.revokedAt !== null || record.expiresAt <= Date.now()) {
    return null;
  }
  record.revokedAt = Date.now();
  const user = findMemoryUser(record.userId);
  return user && user.status === "Active" ? record.userId : null;
}

async function redeemRefreshTokenSql(tokenHash: string, clientId: string): Promise<string | null> {
  const pool = await getSqlPool();
  const claim = await pool
    .request()
    .input("hash", sql.NVarChar(64), tokenHash)
    .input("clientId", sql.NVarChar(64), clientId)
    .query(
      "UPDATE dbo.McpRefreshTokens SET revoked_at = SYSUTCDATETIME() " +
        "OUTPUT CAST(inserted.user_id AS nvarchar(36)) AS userId " +
        "WHERE token_hash=@hash AND client_id=@clientId AND revoked_at IS NULL AND expires_at > SYSUTCDATETIME()",
    );
  const userId: string | undefined = claim.recordset[0]?.userId;
  if (!userId) return null;

  const active = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, userId)
    .query("SELECT id FROM dbo.Users WHERE id=@userId AND status='Active'");
  return active.recordset.length ? userId : null;
}
