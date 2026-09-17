import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { getSqlPool, sql } from "./database";
import { setAttachmentState } from "./request-repository";
import { parseInput } from "./validation";

export function scannerAuthorized(request: Request) {
  const actual = Buffer.from(request.headers.get("x-pulse-scan-secret") || "");
  const expected = Buffer.from(
    process.env.ATTACHMENT_SCAN_WEBHOOK_SECRET || "",
  );
  return (
    expected.length >= 32 &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
const eventSchema = z.object({
  eventType: z.literal("Microsoft.Security.MalwareScanningResult"),
  data: z.object({
    blobUri: z.string().url(),
    eTag: z.string().min(1).max(126),
    scanResultType: z.enum([
      "No threats found",
      "Malicious",
      "Error",
      "Not scanned",
    ]),
  }),
});
export async function processScanEvent(value: unknown) {
  const event = parseInput(eventSchema, value);
  const uri = new URL(event.data.blobUri);
  const container = process.env.AZURE_STORAGE_CONTAINER || "pulse-attachments";
  if (
    uri.protocol !== "https:" ||
    uri.host !==
      `${process.env.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net` ||
    !uri.pathname.startsWith(`/${container}/`) ||
    uri.search ||
    uri.hash
  )
    throw new Error("INVALID_SCAN_BLOB");
  const key = decodeURIComponent(uri.pathname.slice(container.length + 2));
  const etag = `"${event.data.eTag.replace(/^"|"$/g, "")}"`;
  const row = (
    await (
      await getSqlPool()
    )
      .request()
      .input("key", sql.NVarChar(1024), key)
      .query(
        "SELECT CAST(id AS nvarchar(36)) id,scan_state state,upload_etag etag FROM dbo.Attachments WHERE storage_key=@key AND deleted_at IS NULL",
      )
  ).recordset[0];
  if (!row) return { ignored: true };
  // Completion can arrive after the scan event. Request Event Grid redelivery.
  if (row.state === "Pending upload")
    throw new Error("SCAN_COMPLETION_PENDING");
  if (row.etag !== etag || ["Failed", "Infected"].includes(row.state))
    return { ignored: true };
  const state =
    event.data.scanResultType === "No threats found"
      ? "Clean"
      : event.data.scanResultType === "Malicious"
        ? "Infected"
        : "Failed";
  await setAttachmentState(row.id, state, etag);
  return { ignored: false };
}
