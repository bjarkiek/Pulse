import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const b64url = (buf: Buffer) => buf.toString("base64url");

export function randomToken(byteLength = 32): string {
  return b64url(randomBytes(byteLength));
}

export function sha256Base64Url(input: string): string {
  return b64url(createHash("sha256").update(input, "ascii").digest());
}

// PKCE S256 (RFC 7636 §4.6): SHA-256(verifier) must equal the challenge.
export function verifyCodeChallenge(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const computed = Buffer.from(sha256Base64Url(codeVerifier), "ascii");
  const expected = Buffer.from(codeChallenge, "ascii");
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
