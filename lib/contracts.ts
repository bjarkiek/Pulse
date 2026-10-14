import { z } from "zod";
export const shortText = z.string().trim().max(200);
export const longText = z.string().trim().max(5000);
export const requestInputSchema = z.object({
  title: z.string().trim().min(1).max(140),
  problem: longText.min(1),
  area: shortText,
  impact: z.enum(["Low", "Medium", "High", "Critical"]),
  visibility: z.enum(["Private", "Organization"]),
  linkedIdeaId: z
    .string()
    .regex(/^IDEA-\d+$/)
    .optional(),
  requestType: shortText.optional(),
  affectedUsers: z.number().int().min(0).max(2147483647).optional(),
  workaround: longText.optional(),
  desiredTiming: shortText.optional(),
});
export const requestEditSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  problem: longText.min(1).optional(),
});
export const ideaInputSchema = z.object({
  internalTitle: shortText.min(1).optional(),
  internalDescription: longText.min(1).optional(),
  publishedTitle: shortText.optional(),
  publishedDescription: longText.optional(),
  area: shortText.optional(),
  horizon: z.enum(["Now", "Next", "Later", "Released"]).optional(),
  internalStatus: z
    .enum([
      "Discovery",
      "Candidate",
      "Planned",
      "In progress",
      "Released",
      "Not planned",
      "Archived",
    ])
    .optional(),
  ownerId: z.union([z.uuid(), z.literal("")]).optional(),
  decisionRationale: longText.optional(),
  decisionReason: shortText.optional(),
  deliveryReference: z.string().max(1000).optional(),
  deliveryException: z.boolean().optional(),
  releaseNotes: longText.optional(),
  availability: shortText.optional(),
});
export const userInputSchema = z
  .object({
    id: z.string().max(64),
    name: shortText.min(1),
    email: z.string().trim().toLowerCase().max(320).email(),
    status: z.enum(["Active", "Invited", "Suspended"]),
    authentication: z.enum(["OTP", "Entra ID"]),
    memberships: z
      .array(
        z.object({
          companyId: z.string().min(1).max(32),
          role: z.enum([
            "Company admin",
            "Requester",
            "Viewer",
            "Product manager",
            "Internal contributor",
            "System admin",
          ]),
        }),
      )
      .min(1)
      .max(100),
  })
  .refine(
    (v) =>
      new Set(v.memberships.map((m) => m.companyId)).size ===
      v.memberships.length,
  );
export const organizationInputSchema = z.object({
  id: z.string().max(32),
  name: shortText.min(1),
  type: z.enum(["Customer", "Partner", "Internal"]),
  status: z.enum(["Active", "Onboarding", "Inactive"]),
  domain: z.string().max(255),
  users: z.number().int().min(0),
  requests: z.number().int().min(0),
  authentication: z
    .array(z.enum(["OTP", "Entra ID"]))
    .min(1)
    .max(2),
});
export const settingsInputSchema = z.object({
  formulaVersion: z.number().int().positive(),
  attachmentMaxMb: z.number().int().positive(),
  requestAttachmentMaxMb: z.number().int().positive(),
  retentionDays: z.number().int().min(30).max(36500),
  defaultLocale: z.enum(["en", "is"]),
  roadmapDisclaimer: longText.min(1),
  showDemoData: z.boolean(),
  dcOnlyAccess: z.boolean().default(true),
  scoreWeights: z.object({
    impact: z.number().min(0).max(100),
    reach: z.number().min(0).max(100),
    strategy: z.number().min(0).max(100),
    commercial: z.number().min(0).max(100),
    urgency: z.number().min(0).max(100),
  }),
});
export const attachmentInputSchema = z.object({
  fileName: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !/[\x00-\x1f\\/]/.test(v)),
  contentType: z.string().min(1).max(200),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
});

export const draftInputSchema = requestInputSchema.partial().extend({
  title: z.string().max(140).optional(),
  problem: longText.optional(),
});
export const releaseInputSchema = z.object({
  title: shortText.min(1),
  date: z.iso.date(),
  summary: longText.min(1),
  availability: shortText.min(1),
  documentationUrl: z
    .union([z.url().refine((v) => v.startsWith("https://")), z.literal("")])
    .optional(),
  rolloutNotes: longText.optional(),
  ideaIds: z
    .array(z.string().regex(/^IDEA-\d+$/))
    .min(1)
    .max(100),
});
export const commentInputSchema = z.object({
  body: longText.min(1),
  visibility: z.enum(["Customer", "Internal"]),
  attachmentIds: z.array(z.uuid()).max(5).default([]),
});

export const requestMutationSchema = requestEditSchema.extend({
  status: z
    .enum([
      "Submitted",
      "Needs information",
      "Linked",
      "Routed to support",
      "Closed",
      "Withdrawn",
    ])
    .optional(),
  explanation: longText.optional(),
  supportReference: shortText.optional(),
});
export const scanVerdictSchema = z
  .object({ clean: z.boolean().optional(), etag: z.string().min(1).max(128) })
  .strict();

export const triageInputSchema = z.object({
  requestIds: z
    .array(z.string().regex(/^DCI-\d+$/))
    .min(1)
    .max(100),
  ownerId: z.union([z.uuid(), z.literal("me"), z.literal("")]).optional(),
  tagIds: z.array(z.uuid()).max(100).optional(),
  triageDueAt: z
    .string()
    .max(40)
    .refine((v) => !Number.isNaN(Date.parse(v)))
    .optional(),
});
export const savedViewInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scope: z.enum(["Private", "Internal shared"]),
  resourceType: z.enum(["Requests", "Ideas", "Roadmap"]),
  query: z.record(
    z.string().max(100),
    z.union([z.string().max(500), z.array(z.string().max(500)).max(100)]),
  ),
});
export const externalLinkInputSchema = z.object({
  label: z.string().trim().min(1).max(100),
  url: z.string().url().max(2000),
});
export const webhookInputSchema = z.object({
  url: z.string().url().max(2000),
  events: z.array(z.string().min(1).max(100)).min(1).max(100),
});
export const taxonomyInputSchema = z.object({
  id: z.string().max(64),
  kind: z.enum([
    "Product area",
    "Request type",
    "Tag",
    "Strategic theme",
    "Reason category",
  ]),
  value: z.string().trim().min(1).max(120),
  active: z.boolean(),
  sortOrder: z.number().int().min(-2147483648).max(2147483647),
});
const rating = z.number().int().min(1).max(5);
const confidence = z.union([z.literal(50), z.literal(80), z.literal(100)]);
export const scoreInputSchema = z.object({
  impact: rating,
  reach: rating,
  strategicAlignment: rating,
  commercialImpact: rating,
  urgency: rating,
  confidence,
  effort: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(5),
    z.literal(8),
    z.literal(13),
  ]),
  mandatory: z.boolean().optional(),
  rationale: longText.min(1),
});
export const roadmapInputSchema = z.object({
  horizon: z.enum(["Now", "Next", "Later"]),
  targetQuarter: z.string().max(20).optional(),
  confidence: confidence.optional(),
  publish: z.boolean().optional(),
});
const emailAddress = z.string().trim().toLowerCase().max(320).email();
const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,63}$/);
const boilerplateSchema = z.object({
  signOff: z.string().trim().min(1).max(200),
  footer: z.string().trim().max(500),
  supportEmail: emailAddress,
});
export const communicationSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    fromName: z.string().trim().min(1).max(100),
    fromEmail: z.union([emailAddress, z.literal("")]),
    replyTo: z.union([emailAddress, z.literal("")]),
    dataResidency: z.enum(["global", "eu"]),
    unsubscribeGroupId: z.number().int().positive().nullable(),
    sandboxMode: z.boolean(),
    safeMode: z.object({ enabled: z.boolean(), allowedDomains: z.array(domainName).max(50) }),
    tracking: z.object({ opens: z.boolean(), clicks: z.boolean() }),
    dailyCap: z.number().int().min(1).max(1_000_000),
    maxRecipientsPerCampaign: z.number().int().min(1).max(100_000),
    categoriesPrefix: z.string().trim().regex(/^[a-z0-9-]{1,40}$/),
    boilerplate: z.object({ en: boilerplateSchema, is: boilerplateSchema }),
  })
  .refine((v) => !v.enabled || v.fromEmail !== "", { message: "fromEmail required when enabled" })
  // Mail sent without an unsubscribe group has no List-Unsubscribe header and no unsubscribe link (the footer leaves the link out), so the
  // recipient could not leave. While safe mode holds sending to the allow-listed domains that is tolerable; leaving safe mode needs the group first.
  // The message is a code: `parseInput` answers with it, and `REFUSALS` in lib/api-client.ts says it in words.
  .refine((v) => !v.enabled || v.safeMode.enabled || v.unsubscribeGroupId !== null, {
    message: "INVALID_UNSUBSCRIBE_GROUP_REQUIRED",
    path: ["unsubscribeGroupId"],
  });
export const httpsUrl = z.string().trim().url().max(2000).refine((v) => v.startsWith("https://"));
const emailText = (max: number) => z.string().trim().max(max);
export const localizedTextSchema = z.object({ en: emailText(200).min(1), is: emailText(200).optional() });
const linkSchema = z.object({ label: emailText(120).min(1), url: httpsUrl });
export const productUpdateBodySchema = z.object({
  eyebrow: emailText(60).optional(),
  title: emailText(140).min(1),
  subtitle: emailText(200).optional(),
  intro: emailText(2000).min(1),
  highlightsLabel: emailText(60).optional(),
  sections: z
    .array(
      z.object({
        heading: emailText(120).min(1),
        body: emailText(2000).min(1),
        callout: z.object({ tone: z.enum(["warning", "info"]), label: emailText(80).optional(), text: emailText(600).min(1) }).optional(),
        link: linkSchema.optional(),
      }),
    )
    .min(1)
    .max(8),
  note: emailText(600).optional(),
  cta: linkSchema.optional(),
  signOff: emailText(200).optional(),
});
export const serviceNoticeBodySchema = z.object({
  title: emailText(140).min(1),
  summary: emailText(2000).min(1),
  window: z.object({ startsAt: emailText(40).min(1), endsAt: emailText(40).min(1), timezone: emailText(40).min(1) }).optional(),
  impact: emailText(1000).optional(),
  actions: z.array(emailText(300).min(1)).max(10).default([]),
  link: linkSchema.optional(),
  contact: emailText(200).optional(),
  signOff: emailText(200).optional(),
});
export const plainBodySchema = z.object({
  title: emailText(140).min(1),
  paragraphs: z.array(emailText(2000).min(1)).min(1).max(12),
  cta: linkSchema.optional(),
  signOff: emailText(200).optional(),
});
export const templateBodySchemas = {
  "product-update": productUpdateBodySchema,
  "service-notice": serviceNoticeBodySchema,
  plain: plainBodySchema,
} as const;
export const audienceSpecSchema = z.object({
  organizations: z.union([z.literal("all-customers"), z.array(z.string().min(1).max(32)).max(500)]),
  includeOnboarding: z.boolean().default(false),
  includeTestOrganizations: z.boolean().default(false),
  includeMembers: z.boolean().default(true),
  memberRoles: z.array(z.enum(["Company admin", "Requester", "Viewer"])).min(1).max(3).nullable().default(null),
  includeContacts: z.boolean().default(true),
  includeInternalCopy: z.boolean().default(false),
});
export const communicationInputSchema = z
  .object({
    templateKey: z.enum(["product-update", "service-notice", "plain"]),
    topic: z.enum(["product-updates", "service-notices", "security-advisories", "general"]),
    title: shortText.min(1),
    content: z.object({
      subject: localizedTextSchema,
      preheader: localizedTextSchema.partial({ en: true }).optional(),
      body: z.object({ en: z.record(z.string(), z.unknown()), is: z.record(z.string(), z.unknown()).optional() }),
    }),
    audience: audienceSpecSchema,
    fromReleaseId: z.string().regex(/^REL-\d+$/).optional(),
  })
  .superRefine((value, ctx) => {
    const schema = templateBodySchemas[value.templateKey];
    for (const locale of ["en", "is"] as const) {
      const body = value.content.body[locale];
      if (body === undefined) continue;
      const result = schema.safeParse(body);
      if (!result.success)
        ctx.addIssue({ code: "custom", path: ["content", "body", locale], message: "invalid template body" });
    }
  });
export const communicationSendInputSchema = z.object({ scheduledAt: z.iso.datetime().optional() }).strict();
export const communicationTestSendSchema = z.object({ extraRecipients: z.array(emailAddress).max(5).default([]) }).strict();
/** `cancel` stops a Scheduled or Sending campaign for good; `unschedule` turns a Scheduled one back into a Draft. */
export const communicationCancelInputSchema = z.object({ mode: z.enum(["cancel", "unschedule"]).default("cancel") }).strict();
const topicEnum = z.enum(["product-updates", "service-notices", "security-advisories", "general"]);
export const communicationContactInputSchema = z.object({
  id: z.union([z.uuid(), z.literal("")]).optional(),
  organizationId: z.string().min(1).max(32),
  email: emailAddress,
  displayName: shortText.min(1),
  locale: z.enum(["en", "is"]).default("en"),
  topics: z.array(topicEnum).min(1).max(4),
  note: z.string().trim().max(500).optional(),
});
/** Customer self-service never names the organisation; it is the active membership. */
export const companyContactInputSchema = communicationContactInputSchema.omit({ organizationId: true });
/**
 * Request body of a create (POST) and of an edit (PATCH). A create never names a contact and the contact an edit changes is named by
 * the URL, so `id` is not part of either; the schema is not strict, so a stray `id` is dropped rather than acted on.
 */
export const communicationContactCreateSchema = communicationContactInputSchema.omit({ id: true });
export const companyContactCreateSchema = companyContactInputSchema.omit({ id: true });
export const communicationContactImportSchema = z.object({
  organizationId: z.string().min(1).max(32).optional(),
  lines: z.string().min(1).max(16000),
  topics: z.array(topicEnum).min(1).max(4).default(["product-updates", "service-notices"]),
});
/** A System admin suppresses an address by hand. */
export const communicationSuppressionInputSchema = z.object({ email: emailAddress, note: z.string().trim().max(500).optional() }).strict();
/** Lifting a suppression names the address only. */
export const communicationSuppressionRemoveSchema = communicationSuppressionInputSchema.pick({ email: true });
