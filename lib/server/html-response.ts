import { randomBytes } from "node:crypto";
import { contentSecurityPolicy } from "../security-policy";

export function secureHtmlResponse(html: string, request: Request) {
  const supplied = request.headers.get("x-nonce");
  const nonce =
    supplied && /^[A-Za-z0-9+/=]{16,100}$/.test(supplied)
      ? supplied
      : randomBytes(24).toString("base64");
  return new Response(
    html.replaceAll("<script>", `<script nonce="${nonce}">`),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": contentSecurityPolicy(
          nonce,
          process.env.DC_FRAME_ANCESTORS || "'self' https://*.datacentral.ai",
        ),
      },
    },
  );
}
