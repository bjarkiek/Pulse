import { protectedResourceMetadata } from "@/lib/server/mcp/discovery";
import { resolveBaseUrl } from "@/lib/server/mcp/base-url";
import { withCors, corsPreflight } from "@/lib/server/mcp/cors";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => withCors(Response.json(protectedResourceMetadata(resolveBaseUrl(req))));

export const OPTIONS = corsPreflight;
