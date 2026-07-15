import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const specification = JSON.parse(
  await readFile(new URL("../public/openapi.json", import.meta.url), "utf8"),
);

test("the published OpenAPI contract covers launch-critical routes", () => {
  assert.equal(specification.openapi, "3.1.0");
  for (const [path, method] of [
    ["/api/v1/requests", "post"],
    ["/api/v1/requests/draft", "put"],
    ["/api/v1/internal/ideas/{id}/publish", "post"],
    ["/api/v1/internal/ideas/{id}/merge", "post"],
    ["/api/v1/internal/releases/{id}/publish", "post"],
    ["/api/v1/admin/settings", "patch"],
  ]) {
    assert.ok(
      specification.paths[path]?.[method],
      `${method.toUpperCase()} ${path}`,
    );
  }
});

test("documented idempotent operations require an idempotency key", () => {
  for (const [path, method] of [
    ["/api/v1/requests", "post"],
    ["/api/v1/internal/ideas", "post"],
    ["/api/v1/internal/ideas/{id}/publish", "post"],
    ["/api/v1/internal/ideas/{id}/merge", "post"],
    ["/api/v1/internal/releases", "post"],
  ]) {
    const parameters = specification.paths[path][method].parameters || [];
    assert.ok(
      parameters.some(
        (parameter) =>
          parameter.$ref === "#/components/parameters/IdempotencyKey",
      ),
      `${method.toUpperCase()} ${path}`,
    );
  }
});
