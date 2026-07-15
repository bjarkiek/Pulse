import test from "node:test";
import assert from "node:assert/strict";
import { randomToken, sha256Base64Url, verifyCodeChallenge } from "../lib/server/mcp/crypto";

test("verifyCodeChallenge accepts the RFC 7636 appendix B vector", () => {
  // verifier and S256 challenge from RFC 7636 appendix B
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(verifyCodeChallenge(verifier, challenge), true);
});

test("verifyCodeChallenge rejects wrong verifier and out-of-bounds lengths", () => {
  assert.equal(verifyCodeChallenge("a".repeat(43), sha256Base64Url("b".repeat(43))), false);
  assert.equal(verifyCodeChallenge("a".repeat(42), sha256Base64Url("a".repeat(42))), false);
  assert.equal(verifyCodeChallenge("a".repeat(129), sha256Base64Url("a".repeat(129))), false);
});

test("randomToken is url-safe without padding", () => {
  const t = randomToken();
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});
