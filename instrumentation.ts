// Next.js server startup hook (https://nextjs.org/docs/app/guides/instrumentation).
// register() runs exactly once per server-process boot — in dev, `next start`,
// and the standalone Docker server.js — making it the only sanctioned place to
// kick off in-process background services like the Slack Socket Mode connection.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startSlackAssistant } = await import("@/lib/server/slack/socket-service");
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
