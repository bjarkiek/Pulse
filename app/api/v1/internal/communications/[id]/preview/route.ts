import { PREVIEW_CONTENT_SECURITY_POLICY } from "@/lib/security-policy";
import { getIdentity } from "@/lib/server/auth";
import { previewCommunication } from "@/lib/server/communications/campaign-repository";
import { apiError, correlationId } from "@/lib/server/http";

/**
 * The rendered mail: HTML by default, the plain-text part with ?format=text; English unless ?locale=is. The CSP allows images and inline styles only,
 * so a preview never runs script. It is also set in next.config.ts: with the app-wide policy set there first, this header alone would be dropped.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const locale = url.searchParams.get("locale") === "is" ? "is" : "en";
    const format = url.searchParams.get("format") === "text" ? "text" : "html";
    const rendered = await previewCommunication(await getIdentity(request), id, locale);
    return new Response(format === "text" ? rendered.text : rendered.html, {
      headers: {
        "content-type": format === "text" ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
        "content-security-policy": PREVIEW_CONTENT_SECURITY_POLICY,
        "cache-control": "no-store",
        "x-correlation-id": correlation,
      },
    });
  } catch (error) {
    return apiError(error, correlation);
  }
}
