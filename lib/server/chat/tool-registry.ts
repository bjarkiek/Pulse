import { z } from "zod";
import type { ZodRawShape } from "zod";
import type { PulseIdentity } from "@/lib/domain";
import { customerTools } from "./tools-customer";

/**
 * The single source of truth both hosts consume: the in-app assistant wraps
 * these with betaZodTool (z.object(inputSchema)), the MCP endpoint registers
 * them directly (the MCP SDK takes a raw shape, not a z.object()).
 */
export type ChatTool = {
  name: string; // snake_case, e.g. "list_my_requests"
  title?: string;
  description: string; // states WHEN to call it, prerequisites, id formats (DCI-####, IDEA-###), date format yyyy-MM-dd
  inputSchema: ZodRawShape; // zod RAW SHAPE (not z.object) — MCP SDK takes shapes; chat host wraps with z.object()
  readOnly: boolean; // MCP readOnlyHint; chat host flips dataChanged on !readOnly success
  group: "customer" | "internal" | "admin";
  run: (
    identity: PulseIdentity,
    args: Record<string, unknown>,
  ) => Promise<string>;
};

/**
 * Every tool's inputSchema includes this. A function (not a shared const)
 * because tools-customer.ts and tool-registry.ts import from each other —
 * a plain `const` would be in its temporal dead zone the first time the
 * circular import is resolved, but hoisted function declarations are safe.
 */
export function orgIdParam() {
  return z
    .string()
    .max(32)
    .optional()
    .describe(
      "Act in this organization (must be one of the user's memberships); defaults to the active organization",
    );
}

/**
 * Rule: run() never hands repositories the shared per-request identity
 * (requireMembership mutates it) — it scopes a COPY first. Also centralizes
 * error-to-text mapping so every tool's run body can stay a one-liner.
 */
export async function withScope(
  identity: PulseIdentity,
  args: Record<string, unknown>,
  run: (
    scoped: PulseIdentity,
    args: Record<string, unknown>,
  ) => Promise<string>,
): Promise<string> {
  const scoped: PulseIdentity = {
    ...identity,
    organizationId: (args.organization_id as string) ?? identity.organizationId,
  };
  try {
    return await run(scoped, args);
  } catch (error) {
    return chatToolErrorMessage(error);
  }
}

export function chatToolErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "FORBIDDEN" || code === "NOT_FOUND")
    return "That item doesn't exist or you don't have access to it.";
  if (code === "UNAUTHORIZED") return "You are not signed in.";
  if (code === "INVALID_ACTIVE_ORGANIZATION_REQUIRED")
    return "You belong to several organizations — pass organization_id (ask get_me for the list).";
  if (code.startsWith("INVALID_") || code.startsWith("MANDATORY_"))
    return code.replace(/^INVALID_/, "").replaceAll("_", " ").toLowerCase();
  console.error("chat tool: unexpected error", error);
  return "Unexpected error performing that action. Try rephrasing.";
}

// Internal- and admin-group tools land in later tasks (tools-internal.ts /
// tools-admin.ts); getChatTools() already assembles customer ∪ internal ∪
// admin so those files only need to be added to the spread below.
const internalTools: ChatTool[] = [];
const adminTools: ChatTool[] = [];

export function getChatTools(): ChatTool[] {
  return [...customerTools, ...internalTools, ...adminTools];
}
