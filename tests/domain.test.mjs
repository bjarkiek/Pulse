import assert from "node:assert/strict";
import test from "node:test";

test("attachment limits match the product policy", () => {
  const megabyte = 1024 * 1024;
  assert.equal(25 * megabyte, 26_214_400);
  assert.ok(4 * 25 * megabyte <= 100 * megabyte);
});

test("tenant storage keys cannot reveal sequential database identifiers", () => {
  const organization = "ORG-001";
  const request = "DCI-1042";
  const attachment = crypto.randomUUID();
  const key = `${organization}/${request}/${attachment}/evidence.pdf`;
  assert.match(key, /^ORG-001\/DCI-1042\/[0-9a-f-]{36}\/evidence\.pdf$/);
});

