// Starts (or no-ops) the Slack Socket Mode assistant.
//
// Conditional registration: both SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be
// set, or startSlackAssistant() is a no-op — Slack is an entirely optional
// integration and its absence must never affect the rest of the app. A bad
// token or a Slack outage during app.start() is caught and logged, never
// thrown, so a flaky Slack connection can never take the whole process down.
// globalThis.pulseSlackApp both records the live connection for graceful
// shutdown (instrumentation.ts) and guards against double-starting on hot
// reload in dev.

import pkg from "@slack/bolt"; // CJS package under "type":"module" — default-import then destructure
import { registerSlackHandlers } from "./event-handler";

// bolt's .d.ts declares `export default AppClass`, so TypeScript (under
// moduleResolution: "bundler") types the default import as `typeof AppClass`
// itself — it has no `.App` property at the type level. At runtime, though,
// Node's CJS interop binds a default import of a CommonJS module to the
// whole `module.exports` object (verified: `require("@slack/bolt").App ===
// require("@slack/bolt").default`), which DOES have `.App`. The cast below
// tells the compiler what's actually there at runtime without abandoning the
// required default-import-then-destructure shape.
const { App } = pkg as unknown as { App: typeof pkg };

declare global {
  var pulseSlackApp: InstanceType<typeof App> | undefined;
}

export function isSlackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
}

export async function startSlackAssistant(): Promise<void> {
  if (!isSlackConfigured() || globalThis.pulseSlackApp) return; // conditional registration + hot-reload guard
  try {
    const app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      socketMode: true,
    });
    registerSlackHandlers(app);
    await app.start();
    globalThis.pulseSlackApp = app;
    console.log(JSON.stringify({ level: "info", message: "Slack Socket Mode connected" }));
  } catch {
    console.error(JSON.stringify({ level: "error", message: "Slack Socket Mode failed to start" }));
    // swallow — a bad token or Slack outage must never take the app down
  }
}
