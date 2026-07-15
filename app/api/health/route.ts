import { json } from "@/lib/server/http";
import { isAzureSqlConfigured } from "@/lib/server/database";
import { isBlobStorageConfigured } from "@/lib/server/blob-storage";

export async function GET() {
  return json({ status: "ok", dependencies: { azureSql: isAzureSqlConfigured() ? "configured" : "local-preview", blobStorage: isBlobStorageConfigured() ? "configured" : "local-preview" } });
}

