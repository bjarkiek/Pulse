import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomToken, sha256Base64Url, verifyCodeChallenge } from "../lib/server/mcp/crypto";
import { issueAccessToken, verifyAccessToken, createRefreshToken, redeemRefreshToken } from "../lib/server/mcp/tokens";
import { isAllowedRedirectUri } from "../lib/server/mcp/client-store";

beforeEach(() => {
  globalThis.pulseMemoryMcpRefreshTokens = undefined;
  globalThis.pulseMemoryMcpClients = undefined;
  globalThis.pulseMcpEphemeralKey = undefined;
  globalThis.pulseMemoryUsers = undefined;
});

const mcpTestUser = { id: "11111111-1111-4111-8111-111111111111", email: "bjarki@uidata.com", name: "Bjarki" };

test("access token round-trips and binds issuer/audience/client", async () => {
  const token = await issueAccessToken(mcpTestUser, "client-1");
  const claims = await verifyAccessToken(token);
  assert.ok(claims);
  assert.equal(claims.sub, mcpTestUser.id);
  assert.equal(claims.clientId, "client-1");
  assert.equal(await verifyAccessToken(token.slice(0, -3) + "abc"), null);
});

test("refresh token rotates: second redeem fails, wrong client fails", async () => {
  const raw = await createRefreshToken(mcpTestUser.id, "client-1");
  assert.equal(await redeemRefreshToken(raw, "client-2"), null);
  assert.equal(await redeemRefreshToken(raw, "client-1"), mcpTestUser.id);
  assert.equal(await redeemRefreshToken(raw, "client-1"), null); // rotated — single use
});

test("redirect uri policy: https anywhere, http loopback only, no fragments", () => {
  assert.equal(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(isAllowedRedirectUri("http://127.0.0.1:33418/cb"), true);
  assert.equal(isAllowedRedirectUri("http://localhost:5199/cb"), true);
  assert.equal(isAllowedRedirectUri("http://evil.example/cb"), false);
  assert.equal(isAllowedRedirectUri("https://x.example/cb#frag"), false);
  assert.equal(isAllowedRedirectUri("myapp://cb"), true);
});

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
