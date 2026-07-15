import { createHmac, timingSafeEqual } from "node:crypto";

export type DataCentralLaunch = {
  userId: number; userName: string; userDisplayName: string; userEmail?: string;
  tenancyName: string; tenantId: number;
  roleDisplayNames: string[]; roleIds: number[];
  clientUrl: string; timeStamp: string;
  allowedGroupIds?: Array<string | number>; language?: string; theme?: string;
};

// dcsig = base64(HMAC_SHA256(secret, raw dcdata base64 string)). Sign the raw
// param value, standard base64, fixed-time compare with a length guard first
// (timingSafeEqual throws on length mismatch).
export function verifyDcLaunch(dcdata: string, dcsig: string): DataCentralLaunch | null {
  const secret = process.env.DC_APP_SECRET;
  if (!dcdata || !dcsig || !secret) return null;
  const computed = createHmac("sha256", secret).update(dcdata, "utf8").digest("base64");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(dcsig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = Buffer.from(dcdata, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    // Legacy hosts double-encode: base64 → JSON string → JSON object.
    return (typeof parsed === "string" ? JSON.parse(parsed) : parsed) as DataCentralLaunch;
  } catch {
    return null;
  }
}

// Optional hardening: confirm the live DataCentral session using the forwarded
// accessToken. Controlled by DC_SESSION_CHECK: "off" | "when-available" (default).
export async function checkDcSession(
  launch: DataCentralLaunch,
  accessToken: string | undefined,
): Promise<"session_invalid" | "identity_mismatch" | null> {
  if (!accessToken) return null;
  const base = process.env.DC_API_BASE_URL || launch.clientUrl;
  let url: URL;
  try {
    url = new URL("/api/services/app/Session/GetCurrentLoginInformations", base);
  } catch {
    return "session_invalid";
  }
  if (url.protocol !== "https:") return "session_invalid";
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "session_invalid";
    const body = (await res.json()) as { result?: { user?: { emailAddress?: string } } };
    const sessionEmail = body?.result?.user?.emailAddress;
    if (sessionEmail && launch.userEmail &&
        sessionEmail.toLowerCase() !== launch.userEmail.toLowerCase())
      return "identity_mismatch";
    return null;
  } catch {
    return "session_invalid";
  }
}
