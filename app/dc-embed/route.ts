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
  // Loop guard: if cookies are blocked, /dc-auth "succeeds" but the reload bounces back here.
  var attempts = 0;
  try { attempts = parseInt(sessionStorage.getItem("dc-embed-attempts")||"0",10)+1;
        sessionStorage.setItem("dc-embed-attempts", String(attempts)); } catch(e){}
  if (attempts > 2) { showFallback("cookie appears blocked in this browser (attempt "+attempts+")"); return; }

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
      if (res.ok){ try{sessionStorage.removeItem("dc-embed-attempts");}catch(e){}
        ru.searchParams.delete("dcdata"); ru.searchParams.delete("dcsig");
        location.replace(ru.pathname + ru.search + ru.hash); return; }
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
    if (!window.parent || window.parent === window){ location.replace(RETURN); return; }
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
