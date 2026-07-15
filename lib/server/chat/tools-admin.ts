import { z } from "zod";
import { orgIdParam, withScope, type ChatTool } from "./tool-contract";
import {
  listOrganizations,
  listUsers,
  saveOrganization,
  saveUser,
  type OrganizationRecord,
  type UserRecord,
} from "../admin-repository";
import { listTaxonomy, saveTaxonomy, type TaxonomyValue } from "../taxonomy-repository";
import { getSettings, saveSettings, type PulseSettings } from "../settings-repository";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  setWebhookSubscriptionState,
  webhookEvents,
} from "../webhook-repository";

export const adminTools: ChatTool[] = [
  {
    name: "list_organizations",
    title: "List organizations",
    description:
      "List all organizations (customers, partners, internal) with membership and request counts. " +
      "System admin only.",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const orgs = await listOrganizations(scoped);
        if (!orgs.length) return "No organizations found.";
        return orgs
          .map(
            (o) =>
              `${o.id} '${o.name}' (${o.type}, ${o.status}) — domain ${o.domain}, ${o.users} users, ` +
              `${o.requests} requests, auth [${o.authentication.join(", ")}]`,
          )
          .join("\n");
      }),
  },
  {
    name: "save_organization",
    title: "Save organization",
    description:
      "Create or update an organization (id like 'ORG-001'; an existing id updates that organization, a new " +
      "id creates one). users/requests are informational — pass the values from list_organizations back to " +
      "avoid resetting them. Requires at least one authentication method. System admin only. " +
      "Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Organization id, e.g. ORG-001"),
      name: z.string().max(200),
      type: z.enum(["Customer", "Partner", "Internal"]),
      status: z.enum(["Active", "Onboarding", "Inactive"]),
      domain: z.string().describe("Verified email domain"),
      authentication: z.array(z.enum(["OTP", "Entra ID"])).min(1),
      users: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Membership count; preserve from list_organizations"),
      requests: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Request count; preserve from list_organizations"),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const saved = await saveOrganization(scoped, {
          id: input.id as string,
          name: input.name as string,
          type: input.type as OrganizationRecord["type"],
          status: input.status as OrganizationRecord["status"],
          domain: input.domain as string,
          authentication: input.authentication as OrganizationRecord["authentication"],
          users: (input.users as number | undefined) ?? 0,
          requests: (input.requests as number | undefined) ?? 0,
        });
        return `Saved ${saved.id} '${saved.name}' (${saved.type}, ${saved.status}).`;
      }),
  },
  {
    name: "list_users",
    title: "List users",
    description:
      "List all users with their memberships (organization + role) across the platform. System admin only.",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const items = await listUsers(scoped);
        if (!items.length) return "No users found.";
        return items
          .map(
            (u) =>
              `${u.id} ${u.name} <${u.email}> — ${u.status}, auth ${u.authentication}, memberships: ` +
              (u.memberships.length
                ? u.memberships.map((m) => `${m.companyId} (${m.role})`).join("; ")
                : "none"),
          )
          .join("\n");
      }),
  },
  {
    name: "save_user",
    title: "Save user",
    description:
      "Create or update a user and their organization memberships. Pass an existing user id to update, or " +
      "omit id to create a new user. At least one membership is required. System admin only. " +
      "Do not retry on timeout.",
    inputSchema: {
      id: z.string().optional().describe("User id (uuid); omit to create a new user"),
      name: z.string().max(200),
      email: z.string().max(320),
      status: z.enum(["Active", "Invited", "Suspended"]),
      authentication: z.enum(["OTP", "Entra ID"]),
      memberships: z
        .array(
          z.object({
            companyId: z.string(),
            role: z.enum(["Company admin", "Requester", "Viewer", "Product manager"]),
          }),
        )
        .min(1),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const saved = await saveUser(scoped, {
          id: (input.id as string) || "",
          name: input.name as string,
          email: input.email as string,
          status: input.status as UserRecord["status"],
          authentication: input.authentication as UserRecord["authentication"],
          memberships: input.memberships as UserRecord["memberships"],
        });
        return `Saved ${saved.id} ${saved.name} <${saved.email}> (${saved.status}).`;
      }),
  },
  {
    name: "list_taxonomy",
    title: "List taxonomy",
    description:
      "List taxonomy values (product areas, request types, tags, strategic themes, reason categories). " +
      "System admin only.",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const items = await listTaxonomy(scoped);
        if (!items.length) return "No taxonomy values found.";
        return items
          .map(
            (t) =>
              `${t.id} [${t.kind}] '${t.value}' — ${t.active ? "active" : "inactive"}, order ${t.sortOrder}`,
          )
          .join("\n");
      }),
  },
  {
    name: "save_taxonomy",
    title: "Save taxonomy value",
    description:
      "Create or update a taxonomy value (kind: Product area, Request type, Tag, Strategic theme, Reason " +
      "category). Pass an existing id to update, or omit id to create. System admin only. " +
      "Do not retry on timeout.",
    inputSchema: {
      id: z.string().optional().describe("Taxonomy value id (uuid); omit to create a new value"),
      kind: z.enum([
        "Product area",
        "Request type",
        "Tag",
        "Strategic theme",
        "Reason category",
      ]),
      value: z.string().max(120),
      active: z.boolean(),
      sortOrder: z.number().int(),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const saved = await saveTaxonomy(scoped, {
          id: (input.id as string) || "",
          kind: input.kind as TaxonomyValue["kind"],
          value: input.value as string,
          active: input.active as boolean,
          sortOrder: input.sortOrder as number,
        });
        return `Saved ${saved.id} [${saved.kind}] '${saved.value}'.`;
      }),
  },
  {
    name: "get_settings",
    title: "Get settings",
    description:
      "Get platform settings: score weights, formula version, attachment limits, retention, locale, and " +
      "roadmap disclaimer. System admin only.",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const s = await getSettings(scoped);
        return (
          `Formula v${s.formulaVersion}. Score weights: impact ${s.scoreWeights.impact}, ` +
          `reach ${s.scoreWeights.reach}, strategy ${s.scoreWeights.strategy}, ` +
          `commercial ${s.scoreWeights.commercial}, urgency ${s.scoreWeights.urgency} (must sum to 100). ` +
          `Attachment max ${s.attachmentMaxMb}MB, request attachment max ${s.requestAttachmentMaxMb}MB, ` +
          `retention ${s.retentionDays} days, locale ${s.defaultLocale}. ` +
          `Roadmap disclaimer: "${s.roadmapDisclaimer}"`
        );
      }),
  },
  {
    name: "save_settings",
    title: "Save settings",
    description:
      "Update platform settings. scoreWeights (impact/reach/strategy/commercial/urgency) MUST sum to exactly " +
      "100 — changing the weights bumps formulaVersion, which marks prior idea scores as computed under an " +
      "older formula. attachmentMaxMb must be one of 10/25/50; requestAttachmentMaxMb one of 50/100/250 and " +
      ">= attachmentMaxMb. System admin only. Do not retry on timeout.",
    inputSchema: {
      attachmentMaxMb: z.union([z.literal(10), z.literal(25), z.literal(50)]),
      requestAttachmentMaxMb: z.union([z.literal(50), z.literal(100), z.literal(250)]),
      retentionDays: z.number().int().min(30),
      defaultLocale: z.enum(["en", "is"]),
      roadmapDisclaimer: z.string().max(2000),
      scoreWeights: z
        .object({
          impact: z.number(),
          reach: z.number(),
          strategy: z.number(),
          commercial: z.number(),
          urgency: z.number(),
        })
        .describe("Must sum to exactly 100"),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const current = await getSettings(scoped);
        const saved = await saveSettings(scoped, {
          formulaVersion: current.formulaVersion,
          attachmentMaxMb: input.attachmentMaxMb as PulseSettings["attachmentMaxMb"],
          requestAttachmentMaxMb:
            input.requestAttachmentMaxMb as PulseSettings["requestAttachmentMaxMb"],
          retentionDays: input.retentionDays as number,
          defaultLocale: input.defaultLocale as PulseSettings["defaultLocale"],
          roadmapDisclaimer: input.roadmapDisclaimer as string,
          scoreWeights: input.scoreWeights as PulseSettings["scoreWeights"],
        });
        return `Settings saved (formula v${saved.formulaVersion}).`;
      }),
  },
  {
    name: "list_webhooks",
    title: "List webhooks",
    description:
      "List configured webhook subscriptions (url, subscribed events, active state). System admin only.",
    inputSchema: { organization_id: orgIdParam },
    readOnly: true,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped) => {
        const items = await listWebhookSubscriptions(scoped);
        if (!items.length) return "No webhooks configured.";
        return items
          .map(
            (w) =>
              `${w.id} ${w.url} — [${w.events.join(", ")}], ${w.active ? "active" : "inactive"}`,
          )
          .join("\n");
      }),
  },
  {
    name: "create_webhook",
    title: "Create webhook",
    description:
      `Create a webhook subscription. url must be https, not localhost/.local, and must not resolve to a ` +
      `private/loopback address. events must be one or more of: ${webhookEvents.join(", ")}. ` +
      "System admin only. Do not retry on timeout.",
    inputSchema: {
      url: z.string().describe("https:// destination URL"),
      events: z.array(z.enum(webhookEvents)).min(1),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const item = await createWebhookSubscription(scoped, {
          url: input.url as string,
          events: input.events as string[],
        });
        return `Created webhook ${item.id} for [${item.events.join(", ")}] → ${item.url}.`;
      }),
  },
  {
    name: "set_webhook_state",
    title: "Set webhook state",
    description: "Enable or disable a webhook subscription by id. System admin only. Do not retry on timeout.",
    inputSchema: {
      id: z.string().describe("Webhook subscription id"),
      active: z.boolean(),
      organization_id: orgIdParam,
    },
    readOnly: false,
    group: "admin",
    run: (identity, args) =>
      withScope(identity, args, async (scoped, input) => {
        const result = await setWebhookSubscriptionState(
          scoped,
          input.id as string,
          input.active as boolean,
        );
        return `Webhook ${result.id} is now ${result.active ? "active" : "inactive"}.`;
      }),
  },
];
