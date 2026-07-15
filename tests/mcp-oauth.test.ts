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
import { putOnce, takeOnce, CODE_TTL_MS } from "../lib/server/mcp/code-cache";
import { GET as asMetadata } from "../app/.well-known/oauth-authorization-server/route";
import { POST as register } from "../app/oauth/register/route";
import { POST as token } from "../app/oauth/token/route";
import { GET as authorize } from "../app/oauth/authorize/route";
import { POST as decision } from "../app/oauth/authorize/decision/route";

beforeEach(() => {
  globalThis.pulseMemoryMcpRefreshTokens = undefined;
  globalThis.pulseMemoryMcpClients = undefined;
  globalThis.pulseMcpEphemeralKey = undefined;
  globalThis.pulseMemoryUsers = undefined;
  globalThis.pulseMcpCodeCache = undefined;
  globalThis.pulseMcpOauthRateLimit = undefined;
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

test("register accepts valid uris and returns a public client", async () => {
  const res = await register(new Request("http://localhost/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.client_id);
  assert.equal(body.token_endpoint_auth_method, "none");
});

test("register rejects a non-loopback http redirect uri", async () => {
  const res = await register(new Request("http://localhost/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
  }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_redirect_uri");
});

test("token endpoint burns the code on first use", async () => {
  globalThis.pulseMcpCodeCache = undefined;
  globalThis.pulseMemoryUsers = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Bjarki",
      email: "bjarki@uidata.com",
      status: "Active",
      authentication: "Entra ID",
      memberships: [],
    },
  ];
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  putOnce("code", "code-1", {
    clientId: "c1", redirectUri: "https://claude.ai/cb", codeChallenge: challenge,
    userId: "11111111-1111-4111-8111-111111111111",
  }, CODE_TTL_MS);
  const form = () => {
    const f = new URLSearchParams({ grant_type: "authorization_code", client_id: "c1",
      code: "code-1", redirect_uri: "https://claude.ai/cb", code_verifier: verifier });
    return new Request("http://localhost/oauth/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: f.toString() });
  };
  const first = await token(form());
  assert.equal(first.status, 200);
  assert.ok((await first.json()).access_token);
  const replay = await token(form());
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
});

test("token endpoint burns the code even when the first request fails client_id validation", async () => {
  globalThis.pulseMcpCodeCache = undefined;
  globalThis.pulseMemoryUsers = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Bjarki",
      email: "bjarki@uidata.com",
      status: "Active",
      authentication: "Entra ID",
      memberships: [],
    },
  ];
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  putOnce("code", "code-burn", {
    clientId: "c1", redirectUri: "https://claude.ai/cb", codeChallenge: challenge,
    userId: "11111111-1111-4111-8111-111111111111",
  }, CODE_TTL_MS);
  const form = (clientId: string) => {
    const f = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
      code: "code-burn", redirect_uri: "https://claude.ai/cb", code_verifier: verifier });
    return new Request("http://localhost/oauth/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: f.toString() });
  };
  // First request uses the WRONG client_id — validation must fail...
  const invalid = await token(form("WRONG"));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "invalid_grant");
  // ...but the code must already be burned, so a second request with the
  // CORRECT client_id (and everything else valid) must also fail. If the
  // endpoint ever regressed to validate-before-burn, this second call would
  // succeed with a 200 since the code would still be live.
  const retry = await token(form("c1"));
  assert.equal(retry.status, 400);
  assert.equal((await retry.json()).error, "invalid_grant");
});

test("takeOnce returns the value exactly once", () => {
  globalThis.pulseMcpCodeCache = undefined;
  putOnce("code", "k1", { a: 1 }, CODE_TTL_MS);
  assert.deepEqual(takeOnce("code", "k1"), { a: 1 });
  assert.equal(takeOnce("code", "k1"), null);
});

test("authorization-server metadata advertises PKCE S256 and no client secrets", async () => {
  const res = await asMetadata(new Request("http://localhost/.well-known/oauth-authorization-server"));
  const body = await res.json();
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
  assert.ok(res.headers.get("access-control-allow-origin"));
});

test("authorize renders consent for a registered client (dev identity)", async () => {
  const reg = await register(new Request("http://localhost/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
  }));
  const { client_id } = await reg.json();
  const res = await authorize(new Request(
    `http://localhost/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=xyz`));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Allow"));
  const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
  assert.ok(nonce);

  const dec = await decision(new Request("http://localhost/oauth/authorize/decision", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
    body: new URLSearchParams({ nonce: nonce!, action: "allow" }).toString(),
  }));
  assert.equal(dec.status, 302);
  const location = dec.headers.get("location")!;
  assert.match(location, /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=.+&state=xyz$/);

  // replayed nonce is burned
  const replay = await decision(new Request("http://localhost/oauth/authorize/decision", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
    body: new URLSearchParams({ nonce: nonce!, action: "allow" }).toString(),
  }));
  assert.equal(replay.status, 400);
});

test("authorize with unregistered redirect_uri is a 400, not a redirect", async () => {
  const reg = await register(new Request("http://localhost/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
  }));
  const { client_id } = await reg.json();
  const res = await authorize(new Request(
    `http://localhost/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&response_type=code&code_challenge=x&code_challenge_method=S256`));
  assert.equal(res.status, 400);
});
