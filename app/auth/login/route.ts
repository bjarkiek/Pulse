import * as oidc from "openid-client";
import {
  getOidcConfig, isEntraConfigured, oidcStateSetCookie, redirectUri, signOidcState,
} from "@/lib/server/entra-oidc";
import { getRuntimeSettings } from "@/lib/server/settings-repository";
import { publicOrigin } from "@/lib/server/http";

export const dynamic = "force-dynamic";

function sanitizeReturnUrl(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function redirectTo(origin: string, path: string): Response {
  return new Response(null, { status: 302, headers: { location: new URL(path, origin).toString() } });
}

// Entry point for the standalone (non-embedded) sign-in flow. Redirects to
// Entra's authorize endpoint with PKCE S256 + state + nonce; the verifier,
// state, nonce, and sanitized returnUrl travel to /auth/callback in a signed
// transient cookie rather than server-side session storage.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const returnUrl = sanitizeReturnUrl(url.searchParams.get("returnUrl"));

  // "Only allow access via DataCentral" (admin setting, ON by default): the
  // standalone Entra flow is disabled — visitors get a whitelisted notice —
  // EXCEPT when the sign-in was triggered by the MCP OAuth consent page
  // (/oauth/authorize bounce): connecting an MCP client needs a top-level
  // browser session, so that one destination may use Entra sign-in. This is a
  // UX gate, not a hard wall — a provisioned user could hand-craft the consent
  // returnUrl — and access is still bounded by Pulse provisioning either way.
  // The embedded flow (/dc-embed → /dc-auth) never touches this route.
  const mcpConsentBound = returnUrl.startsWith("/oauth/authorize");
  const settings = await getRuntimeSettings().catch(() => null);
  if (settings?.dcOnlyAccess !== false && !mcpConsentBound)
    return redirectTo(publicOrigin(request), "/auth/error?code=dc_only");

  // Default: render the Pulse login screen (Microsoft SSO + e-mail code).
  // The actual Entra redirect runs only when the Microsoft button is followed
  // (?provider=microsoft), below.
  if (url.searchParams.get("provider") !== "microsoft")
    return loginScreen(returnUrl);

  // Graceful degradation: the app must still start (and every other route
  // must still work) when Entra isn't configured — only this flow fails.
  if (!isEntraConfigured()) return redirectTo(publicOrigin(request), "/auth/error?code=oidc_failed");

  try {
    const config = await getOidcConfig();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(), scope: "openid profile email",
      code_challenge: codeChallenge, code_challenge_method: "S256", state, nonce,
    });

    const token = await signOidcState({ cv: codeVerifier, state, nonce, ru: returnUrl });
    if (!token) return redirectTo(publicOrigin(request), "/auth/error?code=oidc_failed");

    return new Response(null, {
      status: 302,
      headers: { location: authUrl.toString(), "set-cookie": oidcStateSetCookie(token) },
    });
  } catch {
    // Discovery/network failure against login.microsoftonline.com — fail
    // into the same whitelisted error page rather than a raw 500.
    return redirectTo(publicOrigin(request), "/auth/error?code=oidc_failed");
  }
}

// ---------------------------------------------------------------------------
// The standalone login screen: Microsoft SSO (when configured) and the e-mail
// one-time-code flow (/auth/otp/start → /auth/otp/verify). Server-rendered
// like /dc-embed; the returnUrl is JSON-encoded with <, >, & escaped so it can
// never break out of the inline script (same XSS guard as dc-embed).
const BS = String.fromCharCode(92); // literal backslash — immune to formatter escape-mangling
function jsStringLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, BS + "u003c")
    .replace(/>/g, BS + "u003e")
    .replace(/&/g, BS + "u0026")
    .replace(new RegExp(String.fromCharCode(8232), "g"), BS + "u2028")
    .replace(new RegExp(String.fromCharCode(8233), "g"), BS + "u2029");
}

function loginScreen(returnUrl: string): Response {
  const microsoft = isEntraConfigured()
    ? `<a class="ms" href="/auth/login?provider=microsoft&returnUrl=${encodeURIComponent(returnUrl)}">Sign in with Microsoft</a>
       <div class="divider"><span>or / eða</span></div>`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in — DataCentral Pulse</title>
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1f2328}
  .card{background:#fff;border:1px solid #e3e5e8;border-radius:12px;box-shadow:0 2px 10px rgba(20,20,43,.06);padding:32px;width:min(400px,calc(100vw - 32px))}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:#666;font-size:13px;margin:0 0 20px}
  .ms{display:block;text-align:center;border:1px solid #d5d8dc;border-radius:8px;padding:10px;text-decoration:none;color:#1f2328;font-weight:600;font-size:14px}
  .ms:hover{background:#f6f7f9}
  .divider{display:flex;align-items:center;gap:10px;margin:18px 0;color:#999;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
  .divider:before,.divider:after{content:"";flex:1;height:1px;background:#e3e5e8}
  label{display:block;font-size:12px;font-weight:600;margin:0 0 6px}
  input{width:100%;box-sizing:border-box;border:1px solid #d5d8dc;border-radius:8px;padding:10px;font-size:14px}
  input:focus{outline:2px solid #7c3aed;border-color:transparent}
  button{width:100%;margin-top:12px;border:0;border-radius:8px;background:#7c3aed;color:#fff;font-weight:600;font-size:14px;padding:11px;cursor:pointer}
  button:disabled{opacity:.5}
  #msg{font-size:12px;margin-top:12px;min-height:16px}
  #msg.err{color:#b3261e}
  #msg.ok{color:#146c2e}
  .step2{display:none}
  .support{margin-top:18px;font-size:11px;color:#888;text-align:center}
  .support a{color:#7c3aed}
</style></head><body>
<main class="card">
  <h1>Sign in to DataCentral Pulse</h1>
  <p class="sub">Skráðu þig inn í Pulse</p>
  ${microsoft}
  <form id="f1">
    <label for="email">Work e-mail / Vinnunetfang</label>
    <input id="email" type="email" autocomplete="email" required placeholder="name@company.is">
    <button type="submit" id="b1">Send sign-in code / Senda kóða</button>
  </form>
  <form id="f2" class="step2">
    <label for="code">Enter the 6-digit code from your e-mail / Sláðu inn kóðann</label>
    <input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="123456">
    <button type="submit" id="b2">Sign in / Skrá inn</button>
  </form>
  <p id="msg"></p>
  <p class="support">Problems? / Vantar aðstoð? <a href="mailto:support@datacentral.ai">support@datacentral.ai</a></p>
</main>
<script>
(function(){
  var RETURN = ${jsStringLiteral(returnUrl)};
  var f1=document.getElementById("f1"), f2=document.getElementById("f2"), msg=document.getElementById("msg");
  function say(text, cls){ msg.textContent=text; msg.className=cls||""; }
  function post(path, body){ return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); }
  f1.addEventListener("submit", function(e){
    e.preventDefault();
    var b=document.getElementById("b1"); b.disabled=true; say("");
    post("/auth/otp/start",{email:document.getElementById("email").value.trim()}).then(function(res){
      b.disabled=false;
      if(res.status===429){ say("Too many codes requested — wait a few minutes. / Of margir kóðar — reyndu aftur síðar.","err"); return; }
      if(res.status===503){ say("E-mail sign-in is not available. Contact support. / Netfangsinnskráning er ekki í boði.","err"); return; }
      if(!res.ok){ say("Could not send a code. / Ekki tókst að senda kóða.","err"); return; }
      f2.style.display="block";
      say("If the account exists, a code was e-mailed. It expires in 10 minutes. / Kóði var sendur ef aðgangurinn er til.","ok");
      document.getElementById("code").focus();
    }).catch(function(){ b.disabled=false; say("Network error. / Netvilla.","err"); });
  });
  f2.addEventListener("submit", function(e){
    e.preventDefault();
    var b=document.getElementById("b2"); b.disabled=true; say("");
    post("/auth/otp/verify",{email:document.getElementById("email").value.trim(),code:document.getElementById("code").value.trim()}).then(function(res){
      if(res.ok){ location.replace(RETURN); return; }
      b.disabled=false;
      return res.json().then(function(d){
        var e=(d&&d.error)||"";
        if(e==="expired") say("The code expired — request a new one. / Kóðinn er útrunninn — biddu um nýjan.","err");
        else if(e==="too_many_attempts") say("Too many attempts — request a new code. / Of margar tilraunir — biddu um nýjan kóða.","err");
        else say("Wrong code. / Rangur kóði.","err");
      });
    }).catch(function(){ b.disabled=false; say("Network error. / Netvilla.","err"); });
  });
})();
</script></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
