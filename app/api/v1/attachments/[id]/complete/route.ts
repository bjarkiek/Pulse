import { getIdentity } from "@/lib/server/auth";
import {
  isBlobStorageConfigured,
  verifyUploadedBlob,
} from "@/lib/server/blob-storage";
import { apiError, correlationId, json } from "@/lib/server/http";
import {
  getAttachment,
  getRequest,
  setAttachmentState,
} from "@/lib/server/request-repository";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const attachment = await getAttachment(identity, id);
    const parent = await getRequest(identity, attachment.requestId);
    if (["Withdrawn", "Closed", "Routed to support"].includes(parent.status))
      throw new Error("INVALID_ATTACHMENT_PARENT_INACTIVE");
    if (isBlobStorageConfigured())
      await verifyUploadedBlob(
        attachment.storageKey,
        Number(attachment.sizeBytes),
      );
    await setAttachmentState(id, "Scanning");
    return json({ scanState: "Scanning" }, {}, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
