export const dynamic = "force-dynamic";

// XSS guard: JSON.stringify alone is NOT safe inside an inline <script> — a
// returnUrl like "/</script><script>…" passes the local-URL check, terminates the
// script element, and executes (CSP allows 'unsafe-inline'). Escape <, >, & and the
// JS line separators after stringifying, and use replacement FUNCTIONS so "$&"-style
// patterns in the value are not interpreted by String.prototype.replace.
function jsStringLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let returnUrl = url.searchParams.get("returnUrl") || "/";
  if (!returnUrl.startsWith("/") || returnUrl.startsWith("//")) returnUrl = "/";
  const origins = (process.env.DC_ALLOWED_PARENT_ORIGINS || "https://app.datacentral.ai")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const html = HANDSHAKE_HTML
    .replace("__ORIGINS__", () => jsStringLiteral(origins))
    .replace("__RETURN__", () => jsStringLiteral(returnUrl));
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const HANDSHAKE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title>
<style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;color:#444}
#fb{display:none;max-width:420px;text-align:center}</style></head><body>
<p id="wait">Connecting to DataCentral…</p>
<div id="fb"><p>Could not sign you in automatically.</p>
  <p><a href="/" target="_top">Open Pulse sign-in</a></p><pre id="diag" style="text-align:left;font-size:11px;color:#999"></pre></div>
<script>
(function () {
  var ALLOWED = __ORIGINS__, RETURN = __RETURN__;
  var done = false, log = [];
  function rec(s){ log.push(s); try{console.log("[dc-embed] "+s);}catch(e){} }
  function isAllowed(o){
    if (ALLOWED.indexOf(o) !== -1) return true;
    try { return new URL(o).hostname.endsWith(".datacentral.ai"); } catch(e){ return false; }
  }
  function showFallback(reason){
    rec("fallback: "+reason);
    document.getElementById("wait").style.display="none";
    var fb=document.getElementById("fb"); fb.style.display="block";
    document.getElementById("diag").textContent = log.join(String.fromCharCode(10));
  }
  // Loop guard against rapid re-auth cycles (e.g. storage fully unavailable, so
  // neither the bearer token nor the cookie survives the post-auth reload).
  // Only RECENT attempts count: a genuine loop cycles in seconds, while a stale
  // counter from an earlier failed session would otherwise trip the guard
  // before a single auth attempt runs (sessionStorage survives every reload in
  // the tab). Attempts older than 60s reset the window.
  var attempts = 0;
  try {
    var lastAt = parseInt(sessionStorage.getItem("dc-embed-attempts-at")||"0",10);
    if (Date.now() - lastAt <= 60000)
      attempts = parseInt(sessionStorage.getItem("dc-embed-attempts")||"0",10);
    attempts += 1;
    sessionStorage.setItem("dc-embed-attempts", String(attempts));
    sessionStorage.setItem("dc-embed-attempts-at", String(Date.now()));
  } catch(e){}
  if (attempts > 2) { showFallback("sign-in loop detected — storage appears blocked in this browser (attempt "+attempts+")"); return; }

  // dcdata/dcsig ride on the returnUrl (proxy preserved the original query) and/or our own URL.
  var here = new URL(location.href), ru = new URL(RETURN, location.origin);
  var DCDATA = here.searchParams.get("dcdata") || ru.searchParams.get("dcdata");
  var DCSIG  = here.searchParams.get("dcsig")  || ru.searchParams.get("dcsig");

  function authenticate(body, src){
    if (done) return; done = true;
    rec("POST /dc-auth ("+src+")");
    fetch("/dc-auth", { method:"POST", credentials:"include",
      headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) })
    .then(function(res){
      if (res.ok){
        // The body token is the embed session credential: the app attaches it as
        // an Authorization Bearer header on every API call, so sign-in survives
        // browsers that refuse the (partitioned) third-party session cookie.
        return res.json().then(function(data){
          try{ if (data && data.token) sessionStorage.setItem("pulse-embed-token", data.token); }catch(e){}
          try{ sessionStorage.removeItem("dc-embed-attempts");
               sessionStorage.removeItem("dc-embed-attempts-at"); }catch(e){}
          ru.searchParams.delete("dcdata"); ru.searchParams.delete("dcsig");
          location.replace(ru.pathname + ru.search + ru.hash);
        });
      }
      return res.text().then(function(t){ done=false; showFallback("/dc-auth "+res.status+" "+t); });
    }).catch(function(e){ done=false; showFallback("/dc-auth failed: "+e); });
  }

  window.addEventListener("message", function (event) {
    var d = event.data || {};
    rec("message from "+event.origin+(isAllowed(event.origin)?"":" [ORIGIN NOT ALLOWED]"));
    if (!isAllowed(event.origin)) return;
    var dcToken = d.accessToken || (d.type === "AccessToken" ? d.token : null);
    var graph   = d.graphToken  || d.aadToken;
    if (dcToken || graph)
      authenticate({ dcData: DCDATA, dcSig: DCSIG, accessToken: dcToken, graphToken: graph },
                   graph ? "envelope+graph" : "envelope");
  });

  function sendReady(){
    if (!window.parent || window.parent === window){
      // Top level (no DataCentral parent to hand us an envelope). A signed
      // launch payload is sufficient on its own: authenticate with it so this
      // browser gets a FIRST-PARTY session cookie — the path that lets an
      // operator reach the MCP OAuth consent page while "Only allow access via
      // DataCentral" is on (open Pulse from DataCentral in a new tab first).
      if (DCDATA && DCSIG){ if (!done) authenticate({ dcData: DCDATA, dcSig: DCSIG }, "hmac-top-level"); return; }
      location.replace(RETURN); return;
    }
    window.parent.postMessage({ type: "AppReady " }, "*");
    window.parent.postMessage({ type: "AppReady"  }, "*");
    rec("sent AppReady");
  }
  if (document.readyState === "complete") sendReady();
  else window.addEventListener("load", sendReady);
  setTimeout(sendReady, 250); setTimeout(sendReady, 1000);

  // A signed payload is sufficient alone — POST after a short grace even if no envelope arrives.
  if (DCDATA && DCSIG) setTimeout(function(){
    if (!done) authenticate({ dcData: DCDATA, dcSig: DCSIG }, "hmac-only");
  }, 1500);
  setTimeout(function(){ if (!done) showFallback("timed out waiting for a token"); }, 8000);
})();
</script></body></html>`;
