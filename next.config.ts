import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { PREVIEW_CONTENT_SECURITY_POLICY } from "./lib/security-policy";

// Version shown in the app footer and on /api/health, fixed at build time so a
// deployment can be recognised: package version, the commit (BUILD_ID passed to
// the container build; "local" otherwise) and the moment the build ran.
const appVersion = JSON.parse(readFileSync("./package.json", "utf8")).version as string;
const buildCommit = (process.env.BUILD_ID || "local").slice(0, 7);

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_BUILD_COMMIT: buildCommit,
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  agentRules: false,
  turbopack: { root: process.cwd() },
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  // mssql must stay external: bundling it gives the instrumentation chunk and
  // the route chunks separate copies, and a SQL pool created by one copy
  // rejects the other copy's type objects ("r.type.validate is not a function")
  // — killing every SQL-backed API in production.
  serverExternalPackages: ["@slack/bolt", "@slack/socket-mode", "@slack/web-api", "mssql"],
  async headers() {
    return [
      { source: "/(.*)", headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
        { key: "Content-Security-Policy", value: "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.blob.core.windows.net" },
      ] },
      // After the catch-all on purpose: when two entries set the same header the last one wins, and Next drops the header of a route handler's
      // response once the name is set, so the preview route's own copy of this policy would never be sent without this entry.
      { source: "/api/v1/internal/communications/:id/preview", headers: [
        { key: "Content-Security-Policy", value: PREVIEW_CONTENT_SECURITY_POLICY },
      ] },
    ];
  },
};

export default nextConfig;
