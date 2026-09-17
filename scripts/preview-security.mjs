import { spawn } from "node:child_process";
const env = {
  ...process.env,
  NODE_ENV: "development",
  AZURE_SQL_SERVER: "",
  AZURE_SQL_CONNECTION_STRING: "",
  AZURE_STORAGE_ACCOUNT_NAME: "",
  SLACK_BOT_TOKEN: "",
  SLACK_APP_TOKEN: "",
  ANTHROPIC_API_KEY: "",
  PULSE_SESSION_SECRET: "",
  NEXT_TELEMETRY_DISABLED: "1",
};
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3107",
  ],
  { env, stdio: "inherit", windowsHide: true },
);
process.on("SIGINT", () => child.kill());
child.on("exit", (code) => process.exit(code || 0));
