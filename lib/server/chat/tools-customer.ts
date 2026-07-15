import { z } from "zod";
import { orgIdParam, withScope, type ChatTool } from "./tool-registry";
import { getIdentityContext } from "../identity-repository";
import {
  createRequest,
  editRequest,
  getRequest,
  getRequestHistory,
  listAttachments,
  listRequests,
  updateRequestStatus,
} from "../request-repository";
import {
  deleteRequestDraft,
  getRequestDraft,
  saveRequestDraft,
} from "../draft-repository";
import {
  addComment,
  editComment,
  listComments,
  removeComment,
} from "../comment-repository";
import { getIdea, listIdeas, toggleFollow } from "../idea-repository";
import {
  listNotifications,
  listReleases,
  markNotificationRead,
} from "../operations-repository";
import { searchSuggestions } from "../search-repository";
import {
  listNotificationPreferences,
  notificationEventTypes,
  saveNotificationPreference,
} from "../notification-preference-repository";

const horizons = ["Now", "Next", "Later", "Released"] as const;

export const customerTools: ChatTool[] = [
  {
    name: "get_me",
    title: "Get my identity",
    description:
      "Get your identity, your organization memberships (with role per organization), and which " +
      "organization is currently active. Call this first if you need an organization_id for another tool.",
    inputSchema: { organization_id: orgIdParam() },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const context = await getIdentityContext(scoped);
        const orgs = context.organizations
          .map(
            (org) =>
              `${org.id} (${org.name}, role ${org.role}${org.active ? ", active" : ""})`,
          )
          .join("; ");
        return (
          `${context.user.name} <${context.user.email}> — memberships: ${orgs || "none"}. ` +
          `Active organization: ${context.activeOrganizationId ?? "none, pass organization_id"}.`
        );
      }),
  },
  {
    name: "list_my_requests",
    title: "List my requests",
    description:
      "List the customer requests (public id DCI-####) visible to you in the active organization, " +
      "optionally filtered by exact status (e.g. Submitted, Needs information, Linked, Routed to support, Closed, Withdrawn).",
    inputSchema: {
      status: z.string().optional().describe("Exact status to filter by"),
      organization_id: orgIdParam(),
    },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const items = await listRequests(scoped);
        const status = input.status as string | undefined;
        const filtered = status
          ? items.filter((item) => item.status === status)
          : items;
        if (!filtered.length) return "No requests found.";
        return filtered
          .map((item) => `${item.id} '${item.title}' — ${item.status}, area ${item.area}`)
          .join("\n");
      }),
  },
  {
    name: "get_request",
    title: "Get request",
    description:
      "Get full details and recent history for a single customer request by its public id (DCI-####). " +
      "Use this to check status, area, impact, visibility, owner, and what happened recently.",
    inputSchema: {
      id: z.string().describe("Request public id, e.g. DCI-1051"),
      organization_id: orgIdParam(),
    },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const id = input.id as string;
        const request = await getRequest(scoped, id);
        const history = await getRequestHistory(scoped, id);
        const recent = history
          .slice(0, 5)
          .map((event) => `${event.action} by ${event.actor ?? "system"} (${event.createdAt})`)
          .join("; ");
        return (
          `${request.id} '${request.title}' — ${request.status}, area ${request.area}, ` +
          `impact ${request.impact}, visibility ${request.visibility}, owner ${request.owner}` +
          (request.linkedIdea ? `, linked idea ${request.linkedIdea}` : "") +
          (recent ? `. Recent history: ${recent}` : "")
        );
      }),
  },
  {
    name: "find_similar",
    title: "Find similar ideas/requests",
    description:
      "Search existing published ideas (IDEA-###) and your organization's requests (DCI-####) for likely " +
      "duplicates of a new problem statement. ALWAYS call before submit_request and mention duplicates to the user.",
    inputSchema: {
      query: z.string().min(3).max(500).describe("The problem statement or title to search for"),
      area: z.string().optional().describe("Product area to bias matching, e.g. 'Distribution'"),
      organization_id: orgIdParam(),
    },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const results = await searchSuggestions(
          scoped,
          input.query as string,
          input.area as string | undefined,
        );
        if (!results.length) return "No similar ideas or requests found.";
        return results
          .map((item) => `${item.id} '${item.title}' (${item.source}) — ${item.why}`)
          .join("\n");
      }),
  },
  {
    name: "submit_request",
    title: "Submit request",
    description:
      "Create a new customer request (DCI-####) in the user's active organization. " +
      "ALWAYS call find_similar first and mention duplicates to the user before creating. " +
      "Visibility 'Organization' is visible to colleagues; 'Private' only to the author and internal staff. " +
      "Do not retry on timeout.",
    inputSchema: {
      title: z.string().max(140).describe("Short title, max 140 chars"),
      problem: z.string().max(5000).describe("Problem or desired outcome, max 5000 chars"),
      area: z.string().describe("Product area, e.g. 'Distribution'"),
      impact: z.string().describe("Impact if unresolved, e.g. Low/Medium/High"),
      visibility: z.enum(["Private", "Organization"]),
      requestType: z.string().optional(),
      affectedUsers: z.number().int().positive().optional(),
      workaround: z.string().optional(),
      desiredTiming: z.string().optional(),
      linkedIdeaId: z.string().optional().describe("IDEA-### id of a PUBLISHED idea this supports"),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, (scoped, input) =>
        createRequest(scoped, input as never).then(
          (r) => `Created ${r.id} '${r.title}' (status ${r.status}).`,
        ),
      ),
  },
  {
    name: "edit_request",
    title: "Edit request",
    description:
      "Edit the title and/or problem statement of your own request. Only allowed while status is " +
      "Submitted or Needs information. Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Request public id, e.g. DCI-1051"),
      title: z.string().max(140).optional(),
      problem: z.string().max(5000).optional(),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const request = await editRequest(scoped, input.id as string, {
          title: input.title as string | undefined,
          problem: input.problem as string | undefined,
        });
        return `Updated ${request.id} '${request.title}' (status ${request.status}).`;
      }),
  },
  {
    name: "set_request_status",
    title: "Set request status",
    description:
      "Change a request's status. Customers may only withdraw their own request (status 'Withdrawn'); " +
      "other transitions require internal staff. Closing a request requires an explanation; routing to " +
      "support requires a supportReference. Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Request public id, e.g. DCI-1051"),
      status: z.enum([
        "Submitted",
        "Needs information",
        "Linked",
        "Routed to support",
        "Closed",
        "Withdrawn",
      ]),
      explanation: z.string().optional().describe("Required when status is Closed"),
      supportReference: z.string().optional().describe("Required when status is Routed to support"),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const result = await updateRequestStatus(
          scoped,
          input.id as string,
          input.status as string,
          {
            explanation: input.explanation as string | undefined,
            supportReference: input.supportReference as string | undefined,
          },
        );
        return `${result.id} is now ${result.status}.`;
      }),
  },
  {
    name: "get_request_draft",
    title: "Get request draft",
    description:
      "Get the current in-progress (unsubmitted) request draft for the active organization, if any.",
    inputSchema: { organization_id: orgIdParam() },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const draft = await getRequestDraft(scoped);
        if (!draft) return "No draft saved.";
        return (
          `Draft: '${draft.title || "(untitled)"}' area ${draft.area}, impact ${draft.impact}, ` +
          `visibility ${draft.visibility}, updated ${draft.updatedAt}.`
        );
      }),
  },
  {
    name: "save_request_draft",
    title: "Save request draft",
    description:
      "Save or update the in-progress request draft for the active organization. Does not submit it. " +
      "Do not retry on timeout.",
    inputSchema: {
      title: z.string().max(140).optional(),
      problem: z.string().max(5000).optional(),
      area: z.string().optional(),
      impact: z.string().optional(),
      visibility: z.enum(["Private", "Organization"]).optional(),
      requestType: z.string().optional(),
      affectedUsers: z.number().int().positive().optional(),
      workaround: z.string().optional(),
      desiredTiming: z.string().optional(),
      linkedIdeaId: z.string().optional(),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const draft = await saveRequestDraft(scoped, input as never);
        return `Draft saved: '${draft.title || "(untitled)"}' updated ${draft.updatedAt}.`;
      }),
  },
  {
    name: "discard_request_draft",
    title: "Discard request draft",
    description:
      "Discard the in-progress request draft for the active organization. Do not retry on timeout.",
    inputSchema: { organization_id: orgIdParam() },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        await deleteRequestDraft(scoped);
        return "Draft discarded.";
      }),
  },
  {
    name: "list_attachments",
    title: "List attachments",
    description:
      "List the files attached to a request (DCI-####) and their virus-scan state. " +
      "Uploading and downloading files is UI-only and not available in chat.",
    inputSchema: {
      id: z.string().describe("Request public id, e.g. DCI-1051"),
      organization_id: orgIdParam(),
    },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const id = input.id as string;
        await getRequest(scoped, id); // confirms access before listing (listAttachments itself is org-scoped only)
        const attachments = await listAttachments(scoped, id);
        if (!attachments.length) return `No attachments on ${id}.`;
        return attachments
          .map((a) => `${a.fileName} (${a.sizeBytes}B, ${a.scanState})`)
          .join("\n");
      }),
  },
  {
    name: "list_comments",
    title: "List comments",
    description:
      "List comments on a request (DCI-####). Set includeInternal to also see internal-only comments " +
      "if you have internal access (the repository enforces this — customers only ever see their own visibility level).",
    inputSchema: {
      id: z.string().describe("Request public id, e.g. DCI-1051"),
      includeInternal: z.boolean().optional(),
      organization_id: orgIdParam(),
    },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const comments = await listComments(
          scoped,
          input.id as string,
          Boolean(input.includeInternal),
        );
        if (!comments.length) return "No comments.";
        return comments
          .map((c) => `[${c.visibility}] ${c.author} (${c.createdAt}): ${c.body}`)
          .join("\n");
      }),
  },
  {
    name: "add_comment",
    title: "Add comment",
    description:
      "Add a comment to a request (DCI-####). Visibility 'Internal' requires internal staff access " +
      "and is rejected otherwise. Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Request public id, e.g. DCI-1051"),
      body: z.string().max(5000),
      visibility: z.enum(["Customer", "Internal"]),
      attachmentIds: z.array(z.string()).optional(),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const comment = await addComment(
          scoped,
          input.id as string,
          input.body as string,
          input.visibility as "Customer" | "Internal",
          (input.attachmentIds as string[] | undefined) ?? [],
        );
        return `Comment added (${comment.visibility}).`;
      }),
  },
  {
    name: "edit_comment",
    title: "Edit comment",
    description:
      "Edit a comment you authored on a request. Customers have a limited time window to edit. Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Request public id, e.g. DCI-1051"),
      commentId: z.string(),
      body: z.string().max(5000),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        await editComment(
          scoped,
          input.id as string,
          input.commentId as string,
          input.body as string,
        );
        return "Comment updated.";
      }),
  },
  {
    name: "remove_comment",
    title: "Remove comment",
    description:
      "Remove (redact) a comment on a request, leaving a tombstone in its place. A reason is required. " +
      "Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Request public id, e.g. DCI-1051"),
      commentId: z.string(),
      reason: z.string().describe("Required reason for removal/moderation"),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        await removeComment(
          scoped,
          input.id as string,
          input.commentId as string,
          input.reason as string,
        );
        return "Comment removed.";
      }),
  },
  {
    name: "browse_ideas",
    title: "Browse ideas",
    description:
      "Browse published ideas (public id IDEA-###), optionally filtered by exact product area or roadmap horizon.",
    inputSchema: {
      area: z.string().optional(),
      horizon: z.enum(horizons).optional(),
      organization_id: orgIdParam(),
    },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const ideas = await listIdeas(scoped);
        const area = input.area as string | undefined;
        const horizon = input.horizon as string | undefined;
        const filtered = ideas.filter(
          (idea) => (!area || idea.area === area) && (!horizon || idea.horizon === horizon),
        );
        if (!filtered.length) return "No ideas found.";
        return filtered
          .map(
            (idea) =>
              `${idea.id} '${idea.title}' — ${idea.status}, area ${idea.area}, horizon ${idea.horizon}`,
          )
          .join("\n");
      }),
  },
  {
    name: "get_idea",
    title: "Get idea",
    description:
      "Get details for a published idea by its public id (IDEA-###). Aliases from merged duplicates " +
      "resolve automatically to the surviving idea.",
    inputSchema: {
      id: z.string().describe("Idea public id, e.g. IDEA-318"),
      organization_id: orgIdParam(),
    },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const { item, canonicalId, redirected } = await getIdea(scoped, input.id as string);
        const note = redirected ? ` (merged into ${canonicalId})` : "";
        return (
          `${item.id} '${item.title}'${note} — ${item.status}, area ${item.area}, horizon ${item.horizon}, ` +
          `${item.organizations} organizations, ${item.followers} followers. ${item.description}`
        );
      }),
  },
  {
    name: "follow_idea",
    title: "Follow idea",
    description:
      "Toggle following an idea (IDEA-###) so you're notified of updates. Set markAsSolvesMyNeed to true " +
      "to also record this idea as solving your organization's need (keeps it followed). Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Idea public id, e.g. IDEA-318"),
      markAsSolvesMyNeed: z.boolean().optional(),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const id = input.id as string;
        const result = await toggleFollow(scoped, id, Boolean(input.markAsSolvesMyNeed));
        return `${id} is now ${result.followed ? "followed" : "unfollowed"} (${result.followers} followers).`;
      }),
  },
  {
    name: "view_roadmap",
    title: "View roadmap",
    description: "View the published roadmap, grouped by horizon (Now, Next, Later, Released).",
    inputSchema: { organization_id: orgIdParam() },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const ideas = await listIdeas(scoped);
        return horizons
          .map((horizon) => {
            const items = ideas.filter((idea) => idea.horizon === horizon);
            const list = items.length
              ? items.map((idea) => `${idea.id} '${idea.title}'`).join(", ")
              : "(none)";
            return `${horizon}: ${list}`;
          })
          .join("\n");
      }),
  },
  {
    name: "list_releases",
    title: "List releases",
    description: "List published product releases with their summary and availability.",
    inputSchema: { organization_id: orgIdParam() },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const items = await listReleases(scoped, false);
        if (!items.length) return "No releases published.";
        return items
          .map((r) => `${r.id} '${r.title}' (${r.date}) — ${r.summary} [${r.availability}]`)
          .join("\n");
      }),
  },
  {
    name: "list_notifications",
    title: "List notifications",
    description: "List your recent notifications.",
    inputSchema: { organization_id: orgIdParam() },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const items = await listNotifications(scoped);
        if (!items.length) return "No notifications.";
        return items
          .map((n) => `${n.id} ${n.eventType} — ${n.readAt ? "read" : "unread"} (${n.createdAt})`)
          .join("\n");
      }),
  },
  {
    name: "mark_notification_read",
    title: "Mark notification read",
    description: "Mark a notification as read. Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Notification id"),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        await markNotificationRead(scoped, input.id as string);
        return "Notification marked as read.";
      }),
  },
  {
    name: "get_notification_preferences",
    title: "Get notification preferences",
    description: "List your notification delivery cadence preferences per event type.",
    inputSchema: { organization_id: orgIdParam() },
    readOnly: true,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const prefs = await listNotificationPreferences(scoped);
        return prefs
          .map((p) => `${p.eventType}: ${p.cadence}${p.mandatory ? " (mandatory Immediate)" : ""}`)
          .join("\n");
      }),
  },
  {
    name: "set_notification_preference",
    title: "Set notification preference",
    description:
      "Set the delivery cadence for a notification event type. Some event types are mandatory and must " +
      "remain Immediate — the repository rejects other cadences for those. Do not retry on timeout.",
    inputSchema: {
      eventType: z.enum(notificationEventTypes),
      cadence: z.enum(["Immediate", "Daily", "Weekly", "Off"]),
      organization_id: orgIdParam(),
    },
    readOnly: false,
    group: "customer",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const saved = await saveNotificationPreference(
          scoped,
          input.eventType as string,
          input.cadence as string,
        );
        return `${saved.eventType} cadence set to ${saved.cadence}.`;
      }),
  },
];
