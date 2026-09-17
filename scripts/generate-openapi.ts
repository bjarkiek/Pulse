import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as contracts from "../lib/contracts";

const specification = JSON.parse(
  fs.readFileSync("docs/openapi-base.json", "utf8"),
);
const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : e.name === "route.ts"
          ? [path.join(dir, e.name)]
          : [],
    );
const schemaNames: Record<string, string> = {
  "POST /api/v1/admin/taxonomy": "taxonomyInputSchema",
  "POST /api/v1/internal/ideas/{id}/external-links": "externalLinkInputSchema",
  "PUT /api/v1/internal/ideas/{id}/roadmap": "roadmapInputSchema",
  "POST /api/v1/internal/ideas/{id}/score": "scoreInputSchema",
  "POST /api/v1/internal/saved-views": "savedViewInputSchema",
  "POST /api/v1/internal/triage/bulk": "triageInputSchema",
  "POST /api/v1/internal/webhooks": "webhookInputSchema",
  "POST /api/v1/requests": "requestInputSchema",
  "PATCH /api/v1/requests/{id}": "requestMutationSchema",
  "POST /api/v1/attachments/{id}/scan-result": "scanVerdictSchema",
  "PUT /api/v1/requests/draft": "draftInputSchema",
  "POST /api/v1/internal/ideas": "ideaInputSchema",
  "PATCH /api/v1/internal/ideas/{id}": "ideaInputSchema",
  "POST /api/v1/admin/users": "userInputSchema",
  "POST /api/v1/admin/organizations": "organizationInputSchema",
  "PATCH /api/v1/admin/settings": "settingsInputSchema",
  "POST /api/v1/internal/releases": "releaseInputSchema",
  "POST /api/v1/requests/{id}/attachments": "attachmentInputSchema",
  "POST /api/v1/requests/{id}/comments": "commentInputSchema",
};
const paths: Record<string, Record<string, unknown>> = {};
for (const file of walk("app/api/v1").sort()) {
  const source = fs.readFileSync(file, "utf8");
  const route =
    "/" +
    file
      .replaceAll("\\", "/")
      .replace(/^app\//, "")
      .replace(/\/route.ts$/, "")
      .replace(/\[([^\]]+)\]/g, "{$1}");
  const methods = [
    ...source.matchAll(
      /export\s+(?:async\s+function|const)\s+(GET|POST|PATCH|PUT|DELETE|OPTIONS)\b/g,
    ),
  ].map((m) => m[1]);
  paths[route] = {};
  for (const method of methods) {
    const old =
      specification.paths[route]?.[method.toLowerCase()] ||
      specification.components[route]?.[method.toLowerCase()] ||
      {};
    const operation = { ...old };
    operation.operationId ||=
      method.toLowerCase() + route.replace(/[^a-zA-Z0-9]+/g, "_");
    operation["x-source-file"] = file.replaceAll("\\", "/");
    operation["x-authorization"] = route.includes("/jobs/")
      ? "Job secret"
      : route.includes("scan-")
        ? "Scanner secret"
        : route.includes("/admin/")
          ? "System admin"
          : route.includes("/internal/")
            ? "Active internal role; writes enforce repository-specific permissions"
            : "Active account and authorized organization/resource";
    operation.security = route.includes("/jobs/")
      ? [{ notificationJobSecret: [] }]
      : route.includes("scan-")
        ? [{ scanWebhookSecret: [] }]
        : [{ sessionCookie: [] }, { sessionBearer: [] }];
    operation.parameters = (old.parameters || []).filter(
      (p: { in?: string; $ref?: string }) =>
        p.in !== "path" &&
        !p.$ref?.endsWith("/Id") &&
        !p.$ref?.endsWith("/PublicId"),
    );
    for (const param of route.matchAll(/\{([^}]+)\}/g))
      operation.parameters.push({
        name: param[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    if (
      source.includes("executeIdempotent(") &&
      method !== "GET" &&
      !operation.parameters.some((p: { $ref?: string }) =>
        p.$ref?.endsWith("IdempotencyKey"),
      )
    )
      operation.parameters.push({
        $ref: "#/components/parameters/IdempotencyKey",
      });
    if (
      source.includes("checkedMutation(") &&
      ["PATCH", "POST", "PUT"].includes(method)
    )
      operation.parameters.push({ $ref: "#/components/parameters/IfMatch" });
    operation.responses = { ...old.responses };
    if (!Object.keys(operation.responses).some((code) => code.startsWith("2")))
      operation.responses["200"] = { $ref: "#/components/responses/Ok" };
    for (const code of ["400", "401", "404", "413", "429", "500"])
      operation.responses[code] = { $ref: "#/components/responses/Error" };
    if (source.includes("executeIdempotent("))
      operation.responses["409"] = { $ref: "#/components/responses/Error" };
    if (source.includes("checkedMutation("))
      for (const code of ["412", "428"])
        operation.responses[code] = { $ref: "#/components/responses/Error" };
    const contract = schemaNames[`${method} ${route}`];
    if (contract)
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${contract}` },
          },
        },
      };
    // Record every body-consuming route; detailed shared domain schemas above are authoritative.
    else if (
      method !== "GET" &&
      /request\.json\(|readJson\(|readJsonValue\(|readInput\(/.test(source)
    )
      operation.requestBody ||= {
        required: !source.includes(".catch(() => ({}))"),
        content: {
          "application/json": {
            schema: route.includes("scan-events")
              ? {
                  type: "array",
                  maxItems: 50,
                  items: { $ref: "#/components/schemas/ScanEvent" },
                }
              : { type: "object", maxProperties: 250 },
          },
        },
      };
    paths[route][method.toLowerCase()] = operation;
  }
}
specification.paths = paths;
for (const name of Object.keys(specification.components))
  if (name.startsWith("/")) delete specification.components[name];
delete specification.components.securitySchemes.appServiceIdentity;
specification.components.securitySchemes.sessionCookie = {
  type: "apiKey",
  in: "cookie",
  name: "pulse-session",
};
specification.components.securitySchemes.sessionBearer = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Pulse session JWT",
};
specification.security = [{ sessionCookie: [] }, { sessionBearer: [] }];
specification.info.version = "1.1.0";
specification.info.description =
  "Generated route inventory and shared Zod input schemas. Application sessions, current accounts and scoped membership govern access. If-Match protects edits/publication; idempotent writes bind caller, body and target. JSON limit: 64 KiB. See docs/production-hardening.md.";
specification.components.parameters.IfMatch = {
  name: "If-Match",
  in: "header",
  required: true,
  description:
    "Opaque version from the latest entity read. Reread on 412; missing precondition returns 428.",
  schema: { type: "string", minLength: 1 },
};
for (const [name, schema] of Object.entries(contracts))
  if (schema instanceof z.ZodObject)
    specification.components.schemas[name] = z.toJSONSchema(schema, {
      io: "input",
    });
specification.components.schemas.ScanEvent = {
  type: "object",
  required: ["eventType", "data"],
  properties: {
    eventType: { const: "Microsoft.Security.MalwareScanningResult" },
    data: {
      type: "object",
      required: ["blobUri", "eTag", "scanResultType"],
      properties: {
        blobUri: { type: "string", format: "uri" },
        eTag: { type: "string", maxLength: 126 },
        scanResultType: {
          enum: ["No threats found", "Malicious", "Error", "Not scanned"],
        },
      },
    },
  },
};
const generated = JSON.stringify(specification, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (fs.readFileSync("public/openapi.json", "utf8") !== generated)
    throw new Error("OpenAPI drift: run npm run openapi:generate");
} else fs.writeFileSync("public/openapi.json", generated);
console.log(`${Object.keys(paths).length} API paths validated`);
