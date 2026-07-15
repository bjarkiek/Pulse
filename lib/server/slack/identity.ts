// Maps an inbound Slack user to a DataCentral Pulse identity.
//
// Identity comes EXCLUSIVELY from Slack's own user record: we call
// users.info to read the workspace-verified profile.email (requires the
// users:read.email scope) and match that email exactly against
// dbo.Users.email. We never derive identity from message text — a message
// body is untrusted input and must not influence who the caller is treated
// as.

import type { PulseIdentity } from "@/lib/domain";
import { getUserByEmail } from "../chat/chat-repository";
import { getIdentityContext } from "../identity-repository";

/** Minimal shape of a Slack WebClient-like object, just enough for users.info. */
export interface SlackUsersInfoClient {
  users: {
    info(args: { user: string }): Promise<{ user?: { profile?: { email?: string } } }>;
  };
}

declare global {
  var pulseSlackEmailCache: Map<string, { email: string; expiresAt: number }> | undefined;
}

const EMAIL_CACHE_TTL_MS = 60 * 60_000; // ~1 hour

/**
 * Reads the workspace-verified email for a Slack user id via users.info,
 * caching the result per Slack user id for ~1 hour. Best-effort: any
 * users.info failure (missing scope, network error, unknown user) resolves
 * to null rather than throwing.
 */
export async function getVerifiedEmail(
  client: SlackUsersInfoClient,
  slackUserId: string,
): Promise<string | null> {
  const cache = (globalThis.pulseSlackEmailCache ||= new Map());
  const now = Date.now();
  const cached = cache.get(slackUserId);
  if (cached) {
    if (cached.expiresAt > now) return cached.email;
    cache.delete(slackUserId);
  }

  let email: string | undefined;
  try {
    const response = await client.users.info({ user: slackUserId });
    email = response.user?.profile?.email;
  } catch {
    return null;
  }
  if (!email) return null;

  cache.set(slackUserId, { email, expiresAt: now + EMAIL_CACHE_TTL_MS });
  return email;
}

const NOT_LINKED_REFUSAL =
  "Your Slack account isn't linked to a DataCentral Pulse user. " +
  "Ask an administrator to add an account with the same email address as your Slack profile.";
const DISABLED_REFUSAL = "Your account is disabled — please contact an administrator.";
const NO_ORG_REFUSAL =
  "Your account has no active organization membership. Ask an administrator to add you to an organization.";

/**
 * Resolves a Slack user id to a PulseIdentity, or a user-facing refusal
 * string if no such identity can be established. Never trust the returned
 * role/isInternal beyond this call's provisional identity — getIdentityContext
 * (and every downstream repository) re-verifies membership and role from the
 * database.
 */
export async function resolveSlackIdentity(
  client: SlackUsersInfoClient,
  slackUserId: string,
): Promise<{ value: PulseIdentity } | { refusal: string }> {
  const email = await getVerifiedEmail(client, slackUserId);
  if (!email) return { refusal: NOT_LINKED_REFUSAL };

  const user = await getUserByEmail(email);
  if (!user) return { refusal: NOT_LINKED_REFUSAL };
  if (user.status !== "Active") return { refusal: DISABLED_REFUSAL };

  // Provisional identity: only id/email/name come from the matched user row.
  // organizationId/role/isInternal are placeholders that getIdentityContext
  // (and every tool/repository behind it) re-verifies — never trust them.
  const provisional: PulseIdentity = {
    id: user.id,
    email: user.email,
    name: user.name,
    organizationId: "",
    role: "Unknown",
    isInternal: false,
  };

  let ctx;
  try {
    ctx = await getIdentityContext(provisional);
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN") return { refusal: NO_ORG_REFUSAL };
    throw error;
  }

  const active =
    ctx.activeOrganizationId ??
    ctx.organizations.find((organization) => organization.type === "Internal")?.id ??
    ctx.organizations[0]?.id;
  if (!active) return { refusal: NO_ORG_REFUSAL };

  return { value: { ...provisional, organizationId: active } };
}
