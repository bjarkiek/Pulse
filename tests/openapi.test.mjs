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
import { readdir } from "node:fs/promises";
async function routes(directory) {
 const result=[];
 for(const entry of await readdir(directory,{withFileTypes:true})) {
  const file=new URL(entry.name+(entry.isDirectory()?"/":""),directory);
  if(entry.isDirectory())result.push(...await routes(file));else if(entry.name==="route.ts")result.push(file);
 }
 return result;
}
test("every implemented API path and method is documented with resolved references",async()=>{
 const root=new URL("../app/api/v1/",import.meta.url);
 for(const file of await routes(root)) {
  const source=await readFile(file,"utf8");
  const route="/api/v1/"+decodeURIComponent(file.href.slice(root.href.length)).replace(/\/route.ts$/,"").replace(/\[([^\]]+)\]/g,"{$1}");
  for(const match of source.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST|PATCH|PUT|DELETE|OPTIONS)\b/g))assert.ok(specification.paths[route]?.[match[1].toLowerCase()],`${match[1]} ${route}`);
 }
 function check(node) {
  if(!node||typeof node!=="object")return;
  if(typeof node.$ref==="string"&&node.$ref.startsWith("#/")){let target=specification;for(const part of node.$ref.slice(2).split("/"))target=target?.[part];assert.ok(target,`unresolved ${node.$ref}`);}
  for(const value of Object.values(node))check(value);
 }
 check(specification);
 assert.ok(!specification.components.securitySchemes.appServiceIdentity);
});
