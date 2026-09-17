import type { PulseIdentity } from "@/lib/domain";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { requireLocalAdapter } from "./production-config";

export async function requireActiveAccount(identity: PulseIdentity) {
  if (!isAzureSqlConfigured()) {
    requireLocalAdapter();
    const user = globalThis.pulseMemoryUsers?.find((u) => u.id === identity.id);
    if (user && user.status !== "Active") throw new Error("FORBIDDEN");
    if (
      user?.tokensValidAfter &&
      identity.sessionIssuedAt &&
      identity.sessionIssuedAt <= user.tokensValidAfter
    )
      throw new Error("UNAUTHORIZED");
    return;
  }
  const result = await (
    await getSqlPool()
  )
    .request()
    .input("id", sql.UniqueIdentifier, identity.id)
    .query(
      "SELECT status,auth_method authMethod,tokens_valid_after tokensValidAfter FROM dbo.Users WHERE id=@id",
    );
  const user = result.recordset[0];
  if (!user || user.status !== "Active") throw new Error("FORBIDDEN");
  if (identity.authMethod === "otp" && user.authMethod !== "OTP")
    throw new Error("FORBIDDEN");
  if (identity.authMethod === "entra" && user.authMethod !== "Entra ID")
    throw new Error("FORBIDDEN");
  if (
    identity.sessionIssuedAt &&
    user.tokensValidAfter &&
    identity.sessionIssuedAt <= new Date(user.tokensValidAfter).getTime()
  )
    throw new Error("UNAUTHORIZED");
}
