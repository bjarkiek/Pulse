/** Only non-production processes may use credential-free, ephemeral adapters. */
export function productionConfigurationErrors(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.NODE_ENV !== "production") return [];
  const errors: string[] = [];
  const required = (name: string, min = 1) => {
    const value = env[name]?.trim();
    if (
      !value ||
      value.length < min ||
      value.startsWith("@Microsoft.KeyVault(")
    )
      errors.push(name);
  };
  if (!env.AZURE_SQL_CONNECTION_STRING && !env.AZURE_SQL_SERVER)
    errors.push("AZURE_SQL_SERVER");
  required("AZURE_STORAGE_ACCOUNT_NAME");
  required("PULSE_SESSION_SECRET", 32);
  required("ATTACHMENT_SCAN_WEBHOOK_SECRET", 32);
  required("NOTIFICATION_JOB_SECRET", 32);
  required("MCP_TOKEN_SIGNING_KEY");
  if (Buffer.from(env.MCP_TOKEN_SIGNING_KEY || "", "base64").length < 64)
    errors.push("MCP_TOKEN_SIGNING_KEY");
  try {
    if (new URL(env.PULSE_PUBLIC_URL || "").protocol !== "https:")
      errors.push("PULSE_PUBLIC_URL");
  } catch {
    errors.push("PULSE_PUBLIC_URL");
  }
  for (const name of [
    "PULSE_ALLOW_DEMO_IDENTITY",
    "PULSE_TRUST_DC_HEADERS",
    "PULSE_TRUST_EASYAUTH_HEADERS",
  ]) {
    if (env[name] === "true") errors.push(name);
  }
  const age = Number(env.DC_LAUNCH_MAX_AGE_MINUTES ?? "5");
  if (!Number.isFinite(age) || age <= 0 || age > 60)
    errors.push("DC_LAUNCH_MAX_AGE_MINUTES");
  if (
    env.DC_SESSION_CHECK &&
    !["required", "when-available"].includes(env.DC_SESSION_CHECK)
  )
    errors.push("DC_SESSION_CHECK");
  for (const group of [
    [
      "AUTH_ENTRA_TENANT_ID",
      "AUTH_ENTRA_CLIENT_ID",
      "AUTH_ENTRA_CLIENT_SECRET",
    ],
    ["AZURE_COMMUNICATION_EMAIL_ENDPOINT", "AZURE_COMMUNICATION_EMAIL_SENDER"],
    ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "ANTHROPIC_API_KEY"],
  ]) {
    // AI without Slack is supported; Slack requires all three values.
    const enabled =
      group[0] === "SLACK_BOT_TOKEN"
        ? Boolean(env.SLACK_BOT_TOKEN || env.SLACK_APP_TOKEN)
        : group.some((n) => Boolean(env[n]));
    if (enabled) group.forEach((n) => required(n));
  }
  // SendGrid (customer communications) is optional, but a value that is
  // there must be a real one: a Key Vault reference that did not resolve, or
  // a blank, would read as "configured" and the mail would go nowhere. An
  // empty value is "not set": infra/main.bicep writes both settings as ''
  // when their parameters are left empty, and that must not stop a
  // deployment that does not use communications.
  if (env.SENDGRID_API_KEY) required("SENDGRID_API_KEY", 10);
  if (env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY)
    required("SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY", 40);
  if (env.DC_APP_SECRET) required("DC_APP_SECRET", 32);
  return [...new Set(errors)];
}

export function assertProductionConfiguration() {
  const errors = productionConfigurationErrors();
  if (errors.length)
    throw new Error(`PRODUCTION_CONFIGURATION_INVALID: ${errors.join(", ")}`);
}

export function requireLocalAdapter() {
  if (process.env.NODE_ENV === "production")
    throw new Error("PRODUCTION_LOCAL_ADAPTER_DISABLED");
}
