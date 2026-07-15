import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionToken, readSession, sessionSetCookie, sessionClearCookie, SESSION_COOKIE,
} from "../lib/server/session";

function requestWithCookie(token: string): Request {
  return new Request("http://localhost/api/v1/me", {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
  });
}

beforeEach(() => {
  delete process.env.PULSE_SESSION_SECRET;
});

test("session token round-trips claims", async () => {
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111",
    email: "bjarki@uidata.com", name: "Bjarki", ext: "dev:local", amr: "dev",
  });
  const claims = await readSession(requestWithCookie(token));
  assert.ok(claims);
  assert.equal(claims.sub, "11111111-1111-4111-8111-111111111111");
  assert.equal(claims.amr, "dev");
  assert.equal(claims.ver, 1);
});

test("tampered session token is rejected", async () => {
  const token = await createSessionToken({
    sub: "11111111-1111-4111-8111-111111111111",
    email: "a@b.c", name: "A", ext: "dev:local", amr: "dev",
  });
  const claims = await readSession(requestWithCookie(token.slice(0, -2) + "xx"));
  assert.equal(claims, null);
});

test("missing cookie yields null", async () => {
  const claims = await readSession(new Request("http://localhost/"));
  assert.equal(claims, null);
});

test("set-cookie strings carry the right attributes", () => {
  const set = sessionSetCookie("abc");
  assert.match(set, /^pulse-session=abc; Path=\/; Max-Age=\d+; HttpOnly/);
  assert.match(sessionClearCookie(), /Max-Age=0/);
});
