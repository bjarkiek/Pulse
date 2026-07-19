export type Tone = "success" | "warning" | "neutral" | "violet" | "error";

export type RequestStatus =
  | "Draft"
  | "Submitted"
  | "Needs information"
  | "Linked"
  | "Routed to support"
  | "Closed"
  | "Withdrawn";

export type RequestRecord = {
  id: string;
  title: string;
  problem: string;
  area: string;
  impact: string;
  status: string;
  tone: Tone;
  visibility: "Private" | "Organization";
  submitted: string;
  owner: string;
  linkedIdea?: string;
  organizationId?: string;
  createdById?: string;
  attachmentCount?: number;
  requestType?: string;
  affectedUsers?: number;
  workaround?: string;
  desiredTiming?: string;
};

export type AttachmentRecord = {
  id: string;
  requestId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanState: "Pending upload" | "Scanning" | "Clean" | "Infected" | "Failed";
  createdAt: string;
};

export type PulseIdentity = {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  role: string;
  isInternal: boolean;
  dcEmbed?: boolean;
  dcOnboard?: boolean;
  authMethod?: "entra" | "dc-hmac" | "dc-graph" | "easyauth" | "dev";
  isVerified?: boolean;
};
