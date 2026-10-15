import { json } from "@/lib/server/http";
import { isAzureSqlConfigured } from "@/lib/server/database";
import { isBlobStorageConfigured } from "@/lib/server/blob-storage";

export async function GET() {
  return json({
    status: "ok",
    version: process.env.NEXT_PUBLIC_APP_VERSION,
    commit: process.env.NEXT_PUBLIC_BUILD_COMMIT,
    builtAt: process.env.NEXT_PUBLIC_BUILD_TIME,
    dependencies: {
      azureSql: isAzureSqlConfigured() ? "configured" : "local-preview",
      blobStorage: isBlobStorageConfigured() ? "configured" : "local-preview",
    },
  });
}
