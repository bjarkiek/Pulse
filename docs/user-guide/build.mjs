// Build the DataCentral Pulse user guide.
//
// Reads the editable template `guide.html`, inlines every screenshot from
// `shots/` as a base64 data URI, and emits a pure-ASCII, self-contained
// `pulse-user-guide.html` (no external requests — safe to publish as an
// Artifact or open directly in a browser).
//
// Run from this folder:   node build.mjs
//
// Why pure-ASCII: the output has no <head>, so it can't declare a charset.
// Entity-encoding all non-ASCII (— · " " etc.) makes it render correctly
// regardless of how it's served. CSS `content:` glyphs use CSS unicode escapes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shotsDir = path.join(dir, "shots");

// 1. Base64-encode the screenshots into a { name: dataURI } map.
const map = {};
for (const f of fs.readdirSync(shotsDir).filter((f) => f.endsWith(".jpeg"))) {
  const b64 = fs.readFileSync(path.join(shotsDir, f)).toString("base64");
  map[f.replace(/\.jpeg$/, "")] = "data:image/jpeg;base64," + b64;
}

// 2. Read the template and split the leading <style> block from the body.
let src = fs.readFileSync(path.join(dir, "guide.html"), "utf8");
const styleClose = src.indexOf("</style>");
let css = src.slice(0, styleClose);
let body = src.slice(styleClose);

// 3. CSS: replace the few non-ASCII glyphs (in content: rules / comments).
css = css
  .replace(/→/g, "\\2192 ") // arrow
  .replace(/↓/g, "\\2193 ") // down arrow
  .replace(/▸/g, "\\25B8 ") // triangle
  .replace(/—/g, "-");      // em dash (comments only)

// 4. Body: numeric-entity-encode every non-ASCII codepoint.
let encoded = "";
for (const ch of body) {
  const cp = ch.codePointAt(0);
  encoded += cp > 127 ? `&#${cp};` : ch;
}
body = encoded;

// 5. Substitute {{IMG:name}} tokens with the base64 data URIs (pure ASCII).
let html = css + body;
const missing = [];
html = html.replace(/\{\{IMG:([a-z0-9-]+)\}\}/g, (m, k) => {
  if (!map[k]) { missing.push(k); return m; }
  return map[k];
});

// 6. Sanity-check and write.
const firstNonAscii = [...html].findIndex((c) => c.codePointAt(0) > 127);
fs.writeFileSync(path.join(dir, "pulse-user-guide.html"), html);
console.log("built pulse-user-guide.html  (%d KB)", Math.round(html.length / 1024));
console.log("images inlined:", Object.keys(map).length);
console.log("unresolved {{IMG}} tokens:", missing.length ? missing.join(", ") : "none");
console.log("pure ASCII:", firstNonAscii === -1 ? "yes" : `NO at ${firstNonAscii}`);
