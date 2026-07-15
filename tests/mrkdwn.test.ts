import test from "node:test";
import assert from "node:assert/strict";
import { toMrkdwn } from "../lib/server/slack/mrkdwn";

test("escapes ampersand and angle brackets in order", () => {
  assert.equal(toMrkdwn("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});
test("converts markdown links to slack form", () => {
  assert.equal(toMrkdwn("see [the request](https://x.example/r/1)"),
    "see <https://x.example/r/1|the request>");
});
test("converts bold and headings", () => {
  assert.equal(toMrkdwn("**bold** and __also__"), "*bold* and *also*");
  assert.equal(toMrkdwn("## Section"), "*Section*");
});
test("converts bullets", () => {
  assert.equal(toMrkdwn("- one\n* two"), "• one\n• two");
});
test("leaves fenced and inline code untouched", () => {
  const doc = "before\n```\n**not bold** <raw>\n```\nafter `x < y` end";
  const out = toMrkdwn(doc);
  assert.ok(out.includes("**not bold** <raw>"));
  assert.ok(out.includes("`x < y`"));
  assert.ok(out.includes("after"));
});
test("mixed document with prose, code, links, headings, and bullets", () => {
  const doc = [
    "# Title & Overview",
    "",
    "See [the docs](https://x.example/d) for `a < b` details.",
    "",
    "- first & foremost",
    "* second <item>",
    "",
    "```js",
    "const x = a < b && **not bold**;",
    "```",
    "",
    "**Done** & __finished__",
  ].join("\n");
  const out = toMrkdwn(doc);
  assert.ok(out.includes("*Title &amp; Overview*"));
  assert.ok(out.includes("See <https://x.example/d|the docs> for `a < b` details."));
  assert.ok(out.includes("• first &amp; foremost"));
  assert.ok(out.includes("• second &lt;item&gt;"));
  assert.ok(out.includes("const x = a < b && **not bold**;"));
  assert.ok(out.includes("*Done* &amp; *finished*"));
});
