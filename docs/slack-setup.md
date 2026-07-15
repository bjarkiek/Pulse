# Slack setup

The DataCentral Pulse assistant can run inside Slack as a bot: DM it directly, or `@mention` it in a channel it has been invited to. It answers questions and runs the same tools as the in-app chat panel, scoped to the caller's own DataCentral Pulse identity and membership.

Slack is entirely optional — `startSlackAssistant()` no-ops unless both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set, and any Slack connection failure is caught and logged, never thrown. The rest of the application is unaffected if Slack is not configured or goes offline.

## 1. Create the app from the manifest

1. Go to <https://api.slack.com/apps?new_app=1>.
2. Choose **From a manifest**.
3. Pick the target workspace.
4. Switch the manifest editor to YAML and paste the contents of [`slack-app-manifest.yaml`](../slack-app-manifest.yaml) from the repository root.
5. Review and click **Create**.

The manifest declares the bot's identity (`DataCentral Pulse`, display name `pulse`), the bot scopes it needs (`app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `reactions:write`, `users:read`, `users:read.email`), the events it subscribes to (`app_mention`, `message.im`), and enables Socket Mode. Do not edit these unless the code that consumes them (`lib/server/slack/`) changes too — the scopes and events are load-bearing for the bot's behavior (see step 3).

## 2. Generate tokens

The app needs two tokens, both secrets:

1. **App-level token** — under **Basic Information** → **App-Level Tokens**, click **Generate Token and Scopes**. Add the `connections:write` scope (required for Socket Mode) and generate. Copy the value starting with `xapp-…`; this is `SLACK_APP_TOKEN`.
2. **Bot token** — under **Install App**, click **Install to Workspace** and approve the requested scopes. Copy the **Bot User OAuth Token** starting with `xoxb-…`; this is `SLACK_BOT_TOKEN`.

Set both as environment variables (locally in `.env.local`, in production as Key Vault-backed App Service settings — see `infra/main.bicep` and `.env.example`). Never commit either token.

## 3. Identity prerequisite

The assistant identifies the Slack caller by calling Slack's `users.info` (via the `users:read.email` scope) to read their workspace-verified profile email, then matches that email **exactly** against `dbo.Users.email`. There is no separate account-linking step and no fallback to message content or display name.

Before a teammate can use the bot in Slack, their Slack profile email must exactly match their existing `dbo.Users.email` row in DataCentral Pulse, and that user must have an active membership. If the emails do not match, or the user has no active DataCentral Pulse account, the bot replies with a refusal explaining that its Slack account isn't linked and to contact an administrator — it never guesses or falls back to a different identity.

## 4. Verification

1. Start (or redeploy) the application with both tokens set. Confirm the log line:

   ```
   {"level":"info","message":"Slack Socket Mode connected"}
   ```

2. **DM test**: open a direct message with the `pulse` bot and send a question. You should see a ⏳ (`hourglass_flowing_sand`) reaction appear on your message almost immediately, followed by a threaded (or inline, for a first DM message) reply once the assistant finishes. The ⏳ reaction is removed once the reply is posted.
3. **Mention test**: `/invite @pulse` into a channel, then post a message that `@mentions` the bot. The same ⏳-reaction-then-threaded-reply behavior should occur, this time always threaded on the triggering message.
4. If the bot does not respond, check that the app is actually running (Socket Mode requires an active outbound connection — there is no incoming webhook URL to misconfigure), and that both tokens are present and valid.

## 5. Single-instance hosting

Socket Mode holds one long-lived WebSocket connection per running process, and the assistant's per-request caches (the Slack email-lookup cache, the OAuth/session caches used by the rest of the app) are in-process memory, not shared state. Running more than one instance of the application with Slack configured means duplicate Socket Mode connections and inconsistent caches across instances.

**Do not scale the App Service plan out to more than one instance while Slack is configured.** See the comment on the plan/SKU in `infra/main.bicep`.

## Further reading

Full application configuration, including all environment variables and infrastructure parameters, is (or will be) covered in `configInfo.md`.
