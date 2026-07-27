// Next.js server startup hook (https://nextjs.org/docs/app/guides/instrumentation).
// register() runs exactly once per server-process boot — in dev, `next start`,
// and the standalone Docker server.js — making it the only sanctioned place to
// kick off in-process background services like the Slack Socket Mode connection.

// Keep this module Edge-clean: it is bundled for BOTH runtimes, so all Node.js
// API usage (process signal handlers etc.) lives in instrumentation-node.ts
// behind the dynamic import — see that file for why.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { start } = await import("./instrumentation-node");
  await start();
}
