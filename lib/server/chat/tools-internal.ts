import { z } from "zod";
import { orgIdParam, withScope, type ChatTool } from "./tool-contract";
import { requireInternalRole } from "../authorization";
import { listRequests } from "../request-repository";
import { bulkUpdateTriage } from "../triage-repository";
import {
  createIdea,
  linkRequest,
  listInternalIdeas,
  mergeIdeas,
  moveRequestLink,
  publishIdea,
  scoreIdea,
  updateIdea,
} from "../product-repository";
import {
  createRelease,
  listAudit,
  listReleases,
  placeRoadmap,
  publishRelease,
} from "../operations-repository";
import {
  addExternalLink,
  listExternalLinks,
  removeExternalLink,
} from "../external-link-repository";
import {
  createSavedView,
  deleteSavedView,
  listSavedViews,
} from "../saved-view-repository";
import {
  exportAuthorizedRequests,
  getAnalyticsSummary,
} from "../analytics-repository";

const ideaStatuses = [
  "Discovery",
  "Candidate",
  "Planned",
  "In progress",
  "Released",
  "Not planned",
  "Archived",
] as const;
const horizons = ["Now", "Next", "Later", "Released"] as const;
const roadmapHorizons = ["Now", "Next", "Later"] as const;
const confidenceSchema = z.union([z.literal(50), z.literal(80), z.literal(100)]);
const effortSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
]);

export const internalTools: ChatTool[] = [
  {
    name: "list_triage_queue",
    title: "List triage queue",
    description:
      "List requests (DCI-####) for an organization for internal triage — pass organization_id for the " +
      "customer organization you want to triage (defaults to the active organization). Internal staff only. " +
      "listRequests itself only checks membership, so this tool gates on internal role explicitly.",
    inputSchema: {
      status: z.string().optional().describe("Exact status to filter by"),
      organization_id: orgIdParam,
    },
    readOnly: true,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        await requireInternalRole(scoped);
        const items = await listRequests(scoped);
        const status = input.status as string | undefined;
        const filtered = status
          ? items.filter((item) => item.status === status)
          : items;
        if (!filtered.length) return "No requests found.";
        return filtered
          .map(
            (item) =>
              `${item.id} '${item.title}' — ${item.status}, area ${item.area}, owner ${item.owner}`,
          )
          .join("\n");
      }),
  },
  {
    name: "bulk_triage",
    title: "Bulk triage",
    description:
      "Bulk-update owner, tags, and/or triage due date for up to 100 requests (DCI-####) at once. " +
      "This is a bulk action — confirm with the user before running on more than 5 requests. " +
      "Do not retry on timeout.",
    inputSchema: {
      requestIds: z
        .array(z.string())
        .max(100)
        .describe("Request public ids, e.g. DCI-1051"),
      ownerId: z.string().optional().describe("User id to assign as owner, or 'me'"),
      tagIds: z.array(z.string()).optional().describe("Tag taxonomy value ids"),
      triageDueAt: z.string().optional().describe("yyyy-MM-dd"),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const result = await bulkUpdateTriage(scoped, {
          requestIds: input.requestIds as string[],
          ownerId: input.ownerId as string | undefined,
          tagIds: input.tagIds as string[] | undefined,
          triageDueAt: input.triageDueAt as string | undefined,
        });
        return `Updated ${result.updated} request(s).`;
      }),
  },
  {
    name: "list_internal_ideas",
    title: "List internal ideas",
    description:
      "List all ideas (IDEA-###) including unpublished/internal ones, with internal status, publish state, " +
      "owner, score, and linked request count. Internal staff only.",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const ideas = await listInternalIdeas(scoped);
        if (!ideas.length) return "No ideas found.";
        return ideas
          .map(
            (idea) =>
              `${idea.id} '${idea.internalTitle}' — ${idea.internalStatus} (publish ${idea.publishState}), ` +
              `area ${idea.area}, horizon ${idea.horizon}` +
              (idea.ownerId ? `, owner ${idea.ownerId}` : "") +
              (idea.score != null ? `, score ${idea.score}` : "") +
              `, linked requests ${idea.linkedRequests ?? 0}`,
          )
          .join("\n");
      }),
  },
  {
    name: "create_idea",
    title: "Create idea",
    description:
      "Create a new internal idea (IDEA-###) in Discovery status. Not customer-visible until published. " +
      "Do not retry on timeout.",
    inputSchema: {
      internalTitle: z.string().max(200).describe("Internal working title"),
      internalDescription: z.string().max(5000),
      area: z.string().optional().describe("Product area, e.g. 'Distribution'"),
      horizon: z.enum(horizons).optional(),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const idea = await createIdea(scoped, input as never);
        return `Created ${idea.id} '${idea.internalTitle}' (status ${idea.internalStatus}).`;
      }),
  },
  {
    name: "update_idea",
    title: "Update idea",
    description:
      "Update an idea's internal/published wording, status, horizon, owner, decision rationale, delivery " +
      "reference, or release notes. WARNING: editing a Published idea demotes it back to Staged (it must be " +
      "re-published to go live again). Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Idea public id, e.g. IDEA-318"),
      internalTitle: z.string().max(200).optional(),
      internalDescription: z.string().max(5000).optional(),
      publishedTitle: z.string().max(200).optional().describe("Customer-visible title"),
      publishedDescription: z
        .string()
        .max(5000)
        .optional()
        .describe("Customer-visible description"),
      area: z.string().optional(),
      internalStatus: z.enum(ideaStatuses).optional(),
      horizon: z.enum(horizons).optional(),
      ownerId: z.string().optional(),
      decisionRationale: z.string().max(2000).optional(),
      decisionReason: z.string().max(200).optional(),
      deliveryReference: z.string().max(1000).optional(),
      deliveryException: z.boolean().optional(),
      releaseNotes: z.string().max(5000).optional(),
      availability: z.string().max(200).optional(),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const idea = await updateIdea(scoped, input.id as string, input as never);
        return `Updated ${idea.id} '${idea.internalTitle}' (status ${idea.internalStatus}, publish ${idea.publishState}).`;
      }),
  },
  {
    name: "publish_idea",
    title: "Publish idea",
    description:
      "Publish an idea's customer-visible wording, making it appear on the public roadmap/catalogue. Set " +
      "confirmed_safe true ONLY after the user explicitly confirms the published wording is customer-safe. " +
      "Requires publishedTitle/publishedDescription to already be set via update_idea. Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Idea public id, e.g. IDEA-318"),
      confirmed_safe: z
        .boolean()
        .describe(
          "Set true ONLY after the user explicitly confirms the published wording is customer-safe",
        ),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const idea = await publishIdea(
          scoped,
          input.id as string,
          Boolean(input.confirmed_safe),
        );
        return `Published ${idea.id} '${idea.title}' (status ${idea.status}).`;
      }),
  },
  {
    name: "link_request_to_idea",
    title: "Link request to idea",
    description:
      "Link a customer request (DCI-####) to an idea (IDEA-###) as supporting evidence. Sets the request's " +
      "status to Linked and records organization interest in the idea. A reason is required. " +
      "Do not retry on timeout.",
    inputSchema: {
      ideaId: z.string().describe("Idea public id, e.g. IDEA-318"),
      requestId: z.string().describe("Request public id, e.g. DCI-1051"),
      reason: z.string().describe("Why this request supports this idea"),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        await linkRequest(
          scoped,
          input.ideaId as string,
          input.requestId as string,
          input.reason as string,
        );
        return `Linked ${input.requestId} to ${input.ideaId}.`;
      }),
  },
  {
    name: "move_request_link",
    title: "Move request link",
    description:
      "Move a request's (DCI-####) link from one idea to another (e.g. after discovering it actually supports " +
      "a different idea). A reason is required. Do not retry on timeout.",
    inputSchema: {
      requestId: z.string().describe("Request public id, e.g. DCI-1051"),
      fromIdeaId: z.string().describe("Current idea public id"),
      toIdeaId: z.string().describe("Target idea public id"),
      reason: z.string(),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const result = await moveRequestLink(
          scoped,
          input.fromIdeaId as string,
          input.requestId as string,
          input.toIdeaId as string,
          input.reason as string,
        );
        return `Moved ${result.requestId} to ${result.targetIdeaPublicId}.`;
      }),
  },
  {
    name: "merge_ideas",
    title: "Merge ideas",
    description:
      "Merge a duplicate idea into a surviving idea — destructive: the source idea's links, followers, and " +
      "interest move to the target and the source becomes an archived alias that redirects to the target. " +
      "Confirm with the user before running. A reason is required. Do not retry on timeout.",
    inputSchema: {
      targetId: z.string().describe("Surviving idea public id, e.g. IDEA-318"),
      sourceId: z.string().describe("Duplicate idea public id to merge away"),
      reason: z.string(),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const result = await mergeIdeas(
          scoped,
          input.targetId as string,
          input.sourceId as string,
          input.reason as string,
        );
        return `Merged ${result.alias} into ${result.survivor}.`;
      }),
  },
  {
    name: "score_idea",
    title: "Score idea",
    description:
      "Record an ICE/RICE-style score snapshot for an idea: impact, reach, strategicAlignment, " +
      "commercialImpact, urgency are each integers 1-5; confidence is 50, 80, or 100; effort is 1, 2, 3, 5, 8, " +
      "or 13 (smaller = less effort); rationale is required. The score is computed server-side from the " +
      "current weight configuration. Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Idea public id, e.g. IDEA-318"),
      impact: z.number().int().min(1).max(5),
      reach: z.number().int().min(1).max(5),
      strategicAlignment: z.number().int().min(1).max(5),
      commercialImpact: z.number().int().min(1).max(5),
      urgency: z.number().int().min(1).max(5),
      confidence: confidenceSchema,
      effort: effortSchema,
      rationale: z.string().describe("Why these numbers"),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const result = await scoreIdea(scoped, input.id as string, {
          impact: input.impact as number,
          reach: input.reach as number,
          strategicAlignment: input.strategicAlignment as number,
          commercialImpact: input.commercialImpact as number,
          urgency: input.urgency as number,
          confidence: input.confidence as 50 | 80 | 100,
          effort: input.effort as 1 | 2 | 3 | 5 | 8 | 13,
          rationale: input.rationale as string,
        });
        return `${input.id} scored ${result.score} (formula v${result.formulaVersion}).`;
      }),
  },
  {
    name: "place_on_roadmap",
    title: "Place idea on roadmap",
    description:
      "Place an idea on the roadmap at a horizon (Now, Next, Later). Optionally set a target quarter, a " +
      "confidence level (50/80/100), and publish (true makes the placement visible on the public roadmap " +
      "immediately). Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Idea public id, e.g. IDEA-318"),
      horizon: z.enum(roadmapHorizons),
      targetQuarter: z.string().optional().describe("e.g. 'Q3 2026'"),
      confidence: confidenceSchema.optional(),
      publish: z.boolean().optional(),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        await placeRoadmap(scoped, input.id as string, {
          horizon: input.horizon as "Now" | "Next" | "Later",
          targetQuarter: input.targetQuarter as string | undefined,
          confidence: input.confidence as 50 | 80 | 100 | undefined,
          publish: input.publish as boolean | undefined,
        });
        return `${input.id} placed on roadmap horizon ${input.horizon}${input.publish ? " (published)" : ""}.`;
      }),
  },
  {
    name: "list_external_links",
    title: "List external links",
    description:
      "List external reference links (design docs, tickets, etc.) attached to an idea (IDEA-###).",
    inputSchema: {
      ideaId: z.string().describe("Idea public id, e.g. IDEA-318"),
      organization_id: orgIdParam,
    },
    readOnly: true,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const links = await listExternalLinks(scoped, input.ideaId as string);
        if (!links.length) return "No external links.";
        return links.map((l) => `${l.id} '${l.label}' — ${l.url}`).join("\n");
      }),
  },
  {
    name: "add_external_link",
    title: "Add external link",
    description:
      "Attach an external https link (label + url) to an idea (IDEA-###). Do not retry on timeout.",
    inputSchema: {
      ideaId: z.string().describe("Idea public id, e.g. IDEA-318"),
      label: z.string().describe("Short link label"),
      url: z.string().describe("https:// URL"),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const link = await addExternalLink(scoped, input.ideaId as string, {
          label: input.label as string,
          url: input.url as string,
        });
        return `Added link ${link.id} '${link.label}' to ${input.ideaId}.`;
      }),
  },
  {
    name: "remove_external_link",
    title: "Remove external link",
    description:
      "Remove an external link from an idea (IDEA-###) by link id. Do not retry on timeout.",
    inputSchema: {
      ideaId: z.string().describe("Idea public id, e.g. IDEA-318"),
      linkId: z.string(),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        await removeExternalLink(scoped, input.ideaId as string, input.linkId as string);
        return `Removed link ${input.linkId} from ${input.ideaId}.`;
      }),
  },
  {
    name: "list_internal_releases",
    title: "List internal releases",
    description: "List all releases including unpublished drafts (public id REL-###).",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const items = await listReleases(scoped, true);
        if (!items.length) return "No releases.";
        return items
          .map(
            (r) =>
              `${r.id} '${r.title}' (${r.date}) — ${r.published ? "Published" : "Draft"}, ` +
              `ideas [${r.ideaIds.join(", ") || "none"}]`,
          )
          .join("\n");
      }),
  },
  {
    name: "create_release",
    title: "Create release",
    description:
      "Create a draft release (REL-###) with title, date, summary, availability, and the idea ids it bundles. " +
      "Not visible to customers until publish_release. Do not retry on timeout.",
    inputSchema: {
      title: z.string().max(200),
      date: z.string().describe("yyyy-MM-dd"),
      summary: z.string().max(5000),
      availability: z.string().describe("e.g. 'Rolling out over 2 weeks'"),
      documentationUrl: z.string().optional(),
      rolloutNotes: z.string().optional(),
      ideaIds: z.array(z.string()).describe("Idea public ids this release bundles, e.g. IDEA-318"),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const release = await createRelease(scoped, input as never);
        return `Created ${release.id} '${release.title}' (${release.date}), draft.`;
      }),
  },
  {
    name: "publish_release",
    title: "Publish release",
    description:
      "Publish a release (REL-###) — HIGH BLAST RADIUS: cascades every bundled idea to Released, sets its " +
      "availability and release notes, and notifies followers by email and in-app. Confirm with the user " +
      "before running. Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Release public id, e.g. REL-3"),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const release = await publishRelease(scoped, input.id as string);
        return `Published ${release.id} '${release.title}' — notified followers.`;
      }),
  },
  {
    name: "list_saved_views",
    title: "List saved views",
    description:
      "List your saved views plus any shared internal views (filters for Requests, Ideas, or Roadmap).",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const items = await listSavedViews(scoped);
        if (!items.length) return "No saved views.";
        return items
          .map((v) => `${v.id} '${v.name}' (${v.resourceType}, ${v.scope})`)
          .join("\n");
      }),
  },
  {
    name: "create_saved_view",
    title: "Create saved view",
    description:
      "Save a filter set as a named view for Requests, Ideas, or Roadmap. Scope 'Internal shared' is visible " +
      "to all internal staff and requires System admin; 'Private' is visible only to you. " +
      "Do not retry on timeout.",
    inputSchema: {
      name: z.string().max(120),
      scope: z.enum(["Private", "Internal shared"]),
      resourceType: z.enum(["Requests", "Ideas", "Roadmap"]),
      query: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .describe("Filter key/value pairs"),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const view = await createSavedView(scoped, {
          name: input.name as string,
          scope: input.scope as "Private" | "Internal shared",
          resourceType: input.resourceType as "Requests" | "Ideas" | "Roadmap",
          query: input.query as Record<string, string | string[]>,
        });
        return `Saved view ${view.id} '${view.name}'.`;
      }),
  },
  {
    name: "delete_saved_view",
    title: "Delete saved view",
    description:
      "Delete a saved view by id. You may delete your own views; System admins may delete any. " +
      "Do not retry on timeout.",
    inputSchema: {
      id: z.string(),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        await deleteSavedView(scoped, input.id as string);
        return `Deleted saved view ${input.id}.`;
      }),
  },
  {
    name: "analytics_summary",
    title: "Analytics summary",
    description:
      "Summarize request volume, open count, product area breakdown, service levels, notification delivery, " +
      "and data quality gaps.",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const summary = await getAnalyticsSummary(scoped);
        const areas =
          summary.areas.map((a) => `${a.area}: ${a.count}`).join(", ") || "none";
        const notifications =
          summary.notifications.map((n) => `${n.state}: ${n.count}`).join(", ") ||
          "none";
        return (
          `Requests: ${summary.requests.total} total, ${summary.requests.open} open. Areas: ${areas}. ` +
          `Avg first response ${summary.serviceLevels.averageFirstResponseHours.toFixed(1)}h, ` +
          `avg triage ${summary.serviceLevels.averageTriageHours.toFixed(1)}h. ` +
          `Notifications: ${notifications}. Data quality: ${summary.dataQuality.missingOwner} missing owner, ` +
          `${summary.dataQuality.missingClassification} missing classification.`
        );
      }),
  },
  {
    name: "export_requests_csv",
    title: "Export requests CSV",
    description:
      "Export all authorized requests as CSV for offline analysis. Returns the row count and a short preview " +
      "only (never the full file) — download the complete CSV from the app's export route.",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const csv = await exportAuthorizedRequests(scoped);
        const withoutBom = csv.startsWith(String.fromCharCode(0xfeff))
          ? csv.slice(1)
          : csv;
        const lines = withoutBom.split(/\r\n/).filter(Boolean);
        const rowCount = Math.max(0, lines.length - 1);
        const preview = lines.slice(0, 21).join("\n");
        return (
          `${rowCount} request(s) exported. Preview (first ${Math.min(20, rowCount)} rows):\n${preview}\n` +
          "Full file: download via the app's CSV export route."
        );
      }),
  },
  {
    name: "search_audit_log",
    title: "Search audit log",
    description:
      "Search recent audit events (who did what, when) by action, entity type, or actor name. " +
      "System admin only. Returns at most 100 matching events, most recent first.",
    inputSchema: {
      query: z.string().optional().describe("Substring to match against action, entity type, or actor name"),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe(
          "How many recent events to fetch before filtering (up to 500, default 100). The formatted output " +
            "is still capped at ~100 entries even if a higher limit is passed — raise this to widen the " +
            "search window, not to get more than ~100 results back.",
        ),
      organization_id: orgIdParam,
    },
    readOnly: true,
    group: "internal",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const items = await listAudit(scoped, (input.limit as number | undefined) ?? 100);
        const query = (input.query as string | undefined)?.toLowerCase();
        const filtered = query
          ? items.filter((e) =>
              [e.action, e.entityType, e.actor].some((v) =>
                v?.toLowerCase().includes(query),
              ),
            )
          : items;
        if (!filtered.length) return "No matching audit events.";
        return filtered
          .slice(0, 100)
          .map(
            (e) =>
              `${e.createdAt} ${e.actor ?? "system"} ${e.action} ${e.entityType}` +
              (e.entityId ? ` ${e.entityId}` : ""),
          )
          .join("\n");
      }),
  },
];
