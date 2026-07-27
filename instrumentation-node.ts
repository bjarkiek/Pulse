// Node-runtime half of instrumentation.ts, loaded via dynamic import ONLY when
// NEXT_RUNTIME === "nodejs". It must stay a separate module: Next also bundles
// instrumentation.ts for the Edge runtime (the proxy runs there), and Node APIs
// that appear statically in that bundle — like process.once below — trip
// Turbopack's Edge-runtime analyzer even when a runtime guard makes them
// unreachable. Behind this import boundary the Edge bundle never sees them.

import { startSlackAssistant } from "@/lib/server/slack/socket-service";
import { getRuntimeSettings } from "@/lib/server/settings-repository";

export async function start() {
  // Prime the "Show demo data" runtime cache (database.ts isDemoDataActive)
  // before the first content request; until primed the app serves real data.
  // Best-effort — a failed read just means the first settings access primes it.
  try { await getRuntimeSettings(); } catch { /* SQL not reachable yet */ }
  await startSlackAssistant();
  // Graceful disconnect on shutdown (spec §5.3). Idempotent — the guard in
  // startSlackAssistant plus this once-handler mean at most one connection and
  // one stop per process.
  const stop = () => {
    void globalThis.pulseSlackApp?.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
