import type { PulseIdentity } from "@/lib/domain";
import { getIdentityContext } from "../identity-repository";
import { customerTools } from "./tools-customer";
import { internalTools } from "./tools-internal";
import { adminTools } from "./tools-admin";

export type {
  ChatTool,
} from "./tool-contract";
export {
  orgIdParam,
  withScope,
  chatToolErrorMessage,
} from "./tool-contract";

// getIdentityContext isn't exported with a named return type — derive one
// here rather than adding an export to identity-repository.ts.
export type IdentityContext = Awaited<ReturnType<typeof getIdentityContext>>;

export function getChatTools() {
  return [...customerTools, ...internalTools, ...adminTools];
}

/**
 * Shared instructions consumed by BOTH the in-app chat system prompt
 * (Task 14) and the MCP ServerInstructions (Task 26). Membership shape is
 * the real one from identity-repository.ts: { id, name, type, role, active }
 * — there is no organizationId/organizationName/organizationType/status field.
 */
export function buildAssistantInstructions(
  identity: PulseIdentity,
  ctx: IdentityContext,
): string {
  const membership = ctx.organizations.find(
    (o) => o.id === (ctx.activeOrganizationId ?? identity.organizationId),
  );
  const internal = ctx.organizations.find((o) => o.type === "Internal");
  return `DataCentral Pulse is the customer-feedback and product-roadmap tool where customers
submit requests (DCI-####) and follow product ideas (IDEA-###), and the DataCentral team
triages, links, scores, publishes and releases them.
You are acting as ${identity.name} (${identity.email})${membership ? `, active organization ${membership.name} (role: ${membership.role})` : ""}.
${internal ? `They are DataCentral staff (${internal.role}).` : "They are a customer user: only their own organization's data is accessible. Politely refuse triage, internal, or admin actions."}
Permissions are enforced server-side.

Rules: requests are private to their organization; ideas are the public catalogue.
Request statuses: Draft, Submitted, Needs information, Linked, Routed to support, Closed, Withdrawn —
customers may edit only while Submitted/Needs information and may only Withdraw.
Idea statuses: Discovery, Candidate, Planned, In progress, Released, Not planned, Archived;
publishing customer-visible wording requires an explicit safe-wording confirmation.
Use find_similar before submit_request. Titles ≤140 chars; text fields ≤5000. Dates are yyyy-MM-dd.
Refer to items by public ids (DCI-####, IDEA-###, REL-###).`;
}
