import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { randomToken, sha256Base64Url, verifyCodeChallenge } from "../lib/server/mcp/crypto";
import {
  issueAccessToken,
  verifyAccessToken,
  createRefreshToken,
  redeemRefreshToken,
  MCP_ISSUER,
  MCP_AUDIENCE,
} from "../lib/server/mcp/tokens";
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

test("verifyAccessToken rejects a token signed with a different key, wrong issuer, or wrong audience", async () => {
  // Pin a known signing key for this test so it doesn't depend on whichever
  // key mode (configured vs. ephemeral) happens to be active in the process.
  const originalEnv = process.env.MCP_TOKEN_SIGNING_KEY;
  const testKeyBase64 = randomBytes(64).toString("base64");
  process.env.MCP_TOKEN_SIGNING_KEY = testKeyBase64;
  try {
    // Sanity check: a token issued under this configured key verifies fine.
    const validToken = await issueAccessToken(mcpTestUser, "client-1");
    assert.ok(await verifyAccessToken(validToken));

    const realKey = Buffer.from(testKeyBase64, "base64");
    const payload = { email: mcpTestUser.email, name: mcpTestUser.name, client_id: "client-1" };

    // (a) signed with a different key entirely
    const wrongKeyToken = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(mcpTestUser.id)
      .setIssuedAt()
      .setExpirationTime("1h")
      .setIssuer(MCP_ISSUER)
      .setAudience(MCP_AUDIENCE)
      .sign(randomBytes(64));
    assert.equal(await verifyAccessToken(wrongKeyToken), null);

    // (b) real key, wrong issuer
    const wrongIssuerToken = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(mcpTestUser.id)
      .setIssuedAt()
      .setExpirationTime("1h")
      .setIssuer("not-pulse")
      .setAudience(MCP_AUDIENCE)
      .sign(realKey);
    assert.equal(await verifyAccessToken(wrongIssuerToken), null);

    // (c) real key, wrong audience
    const wrongAudienceToken = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(mcpTestUser.id)
      .setIssuedAt()
      .setExpirationTime("1h")
      .setIssuer(MCP_ISSUER)
      .setAudience("not-pulse-mcp")
      .sign(realKey);
    assert.equal(await verifyAccessToken(wrongAudienceToken), null);
  } finally {
    if (originalEnv === undefined) delete process.env.MCP_TOKEN_SIGNING_KEY;
    else process.env.MCP_TOKEN_SIGNING_KEY = originalEnv;
  }
});

test("refresh token rotates: second redeem fails, wrong client fails", async () => {
  const raw = await createRefreshToken(mcpTestUser.id, "client-1");
  assert.equal(await redeemRefreshToken(raw, "client-2"), null);
  assert.equal(await redeemRefreshToken(raw, "client-1"), mcpTestUser.id);
  assert.equal(await redeemRefreshToken(raw, "client-1"), null); // rotated — single use
});

test("refresh redeem returns null for a non-Active user, even though the token is unrevoked and unexpired", async () => {
  globalThis.pulseMemoryUsers = [
    {
      id: mcpTestUser.id,
      name: mcpTestUser.name,
      email: mcpTestUser.email,
      status: "Suspended",
      authentication: "Entra ID",
      memberships: [],
    },
  ];
  const raw = await createRefreshToken(mcpTestUser.id, "client-1");
  assert.equal(await redeemRefreshToken(raw, "client-1"), null);
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
