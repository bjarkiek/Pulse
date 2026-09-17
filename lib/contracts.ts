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
