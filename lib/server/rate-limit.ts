import { verifyAccessToken } from "./mcp/tokens";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { readSession } from "./session";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

type Entry = { count: number; resetAt: number };
declare global {
  var pulseSharedLocalLimits: Map<string, Entry> | undefined;
}

export function trustedClientIp(request: Request) {
  const hops = Number(process.env.PULSE_TRUSTED_PROXY_HOPS || "0");
  if (!Number.isInteger(hops) || hops < 1 || hops > 5)
    return "untrusted-ingress";
  const forwarded =
    request.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((s) => s.trim()) || [];
  const ip = forwarded[forwarded.length - hops];
  return ip && isIP(ip) ? ip : "unknown";
}

export async function consumeLimit(
  key: string,
  limit: number,
  windowMs = 60_000,
) {
  const bucket = createHash("sha256").update(key).digest("hex");
  if (!isAzureSqlConfigured()) {
    const map = (globalThis.pulseSharedLocalLimits ||= new Map());
    const now = Date.now();
    for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
    if (!map.has(bucket) && map.size >= 5000) throw new Error("RATE_LIMITED");
    const value = map.get(bucket) || { count: 0, resetAt: now + windowMs };
    value.count++;
    map.set(bucket, value);
    if (value.count > limit) throw new Error("RATE_LIMITED");
    return;
  }
  const result = await (
    await getSqlPool()
  )
    .request()
    .input("bucket", sql.Char(64), bucket)
    .input("window", sql.Int, windowMs).query(`
      DELETE TOP(100) FROM dbo.RateLimits WHERE expires_at<=SYSUTCDATETIME();
      MERGE dbo.RateLimits WITH(HOLDLOCK) AS t USING(SELECT @bucket bucket) AS s ON t.bucket=s.bucket
      WHEN MATCHED THEN UPDATE SET count=CASE WHEN t.expires_at<=SYSUTCDATETIME() THEN 1 ELSE t.count+1 END,
        expires_at=CASE WHEN t.expires_at<=SYSUTCDATETIME() THEN DATEADD(millisecond,@window,SYSUTCDATETIME()) ELSE t.expires_at END
      WHEN NOT MATCHED THEN INSERT(bucket,count,expires_at) VALUES(@bucket,1,DATEADD(millisecond,@window,SYSUTCDATETIME()))
      OUTPUT inserted.count;
    `);
  if (result.recordset[0].count > limit) throw new Error("RATE_LIMITED");
}

export async function enforceRateLimit(
  request: Request,
  group: string,
  limit: number,
) {
  const session = await readSession(request);
  await consumeLimit(`global:${group}`, Math.max(1000, limit * 20));
  const mcp =
    !session && group === "mcp"
      ? await verifyAccessToken(
          request.headers.get("authorization")?.replace(/^Bearer /i, "") || "",
        )
      : null;
  await consumeLimit(
    `${group}:${mcp ? `user:${mcp.sub}` : session ? `user:${session.sub}` : `ip:${trustedClientIp(request)}`}`,
    limit,
  );
}
