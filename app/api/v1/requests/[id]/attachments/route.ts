import { getIdentity } from "@/lib/server/auth";
import {
  createUploadUrl,
  isBlobStorageConfigured,
} from "@/lib/server/blob-storage";
import { apiError, correlationId, json } from "@/lib/server/http";
import { executeIdempotent } from "@/lib/server/idempotency";
import {
  listAttachments,
  requestAttachmentBytes,
} from "@/lib/server/request-repository";
import { getRuntimeSettings } from "@/lib/server/settings-repository";

const allowed: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "application/pdf": ["pdf"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "application/zip": ["zip"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "docx",
  ],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
    "pptx",
  ],
};

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const items = await listAttachments(await getIdentity(request), id);
    return json(
      {
        items: items.map((item) => ({
          id: item.id,
          requestId: item.requestId,
          fileName: item.fileName,
          contentType: item.contentType,
          sizeBytes: item.sizeBytes,
          scanState: item.scanState,
          createdAt: item.createdAt,
        })),
      },
      {},
      correlation,
    );
  } catch (error) {
    return apiError(error, correlation);
  }
}

export async function POST(request: Request, context: Context) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const identity = await getIdentity(request);
    const result = await executeIdempotent(
      request,
      identity,
      `attachment.create:${id}`,
      201,
      async () => {
        const body = await request.json();
        const fileName = String(body.fileName).slice(0, 255);
        const extension = fileName.toLowerCase().split(".").pop() || "";
        const settings = await getRuntimeSettings();
        if (
          !allowed[body.contentType]?.includes(extension) ||
          body.sizeBytes <= 0 ||
          body.sizeBytes > settings.attachmentMaxMb * 1024 * 1024
        )
          throw new Error("INVALID_ATTACHMENT");
        const attachment = await requestAttachmentBytes(identity, id, {
          fileName,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
        });
        const target = isBlobStorageConfigured()
          ? await createUploadUrl(attachment.storageKey)
          : {
              uploadUrl: `/api/v1/attachments/${attachment.id}/content`,
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            };
        return {
          attachment: {
            id: attachment.id,
            fileName: attachment.fileName,
            scanState: attachment.scanState,
          },
          ...target,
        };
      },
    );
    return json(result.body, { status: result.status }, correlation);
  } catch (error) {
    return apiError(error, correlation);
  }
}
