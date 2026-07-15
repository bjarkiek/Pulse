// Slack event handler: routes DMs and @mentions through the shared assistant.
//
// Both entry points funnel into the same handle() — same identity resolution,
// same sendChat "brain" (history, tools, permissions), same reaction/threading/
// error-handling behavior. Mentions always reply in a thread rooted at the
// trigger message; DMs reply inline, or in-thread if the human already asked
// inside a thread.

import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { GenericMessageEvent } from "@slack/types";
import { sendChat } from "../chat/assistant-service";
import { isDuplicate } from "./dedupe";
import { resolveSlackIdentity } from "./identity";
import { toMrkdwn } from "./mrkdwn";

interface IncomingMsg {
  channel: string;
  ts: string;
  threadTs?: string;
  user: string;
  text: string;
  key: string;
}

export function registerSlackHandlers(app: App) {
  app.event("app_mention", async ({ event, client }) => {
    if (!event.user || (event as { bot_id?: string }).bot_id) return; // ignore events with no human author (bot mentions, loops)
    await handle(client, {
      channel: event.channel,
      ts: event.ts,
      threadTs: event.ts, // mentions: always thread on the trigger
      user: event.user,
      text: stripMentions(event.text),
      key: event.client_msg_id || `${event.channel}:${event.ts}`,
    });
  });

  app.message(async ({ message, client }) => {
    const m = message as GenericMessageEvent;
    if (m.channel_type !== "im" || m.subtype || (m as { bot_id?: string }).bot_id || !m.user) return; // humans-in-DM only
    await handle(client, {
      channel: m.channel,
      ts: m.ts,
      threadTs: m.thread_ts, // DMs: inline, or in-thread if asked in one
      user: m.user,
      text: m.text ?? "",
      key: m.client_msg_id || `${m.channel}:${m.ts}`,
    });
  });
}

async function handle(client: WebClient, msg: IncomingMsg) {
  if (isDuplicate(msg.key)) return;
  if (!msg.text.trim()) return;
  await best(() =>
    client.reactions.add({ channel: msg.channel, timestamp: msg.ts, name: "hourglass_flowing_sand" }),
  );
  try {
    const resolved = await resolveSlackIdentity(client, msg.user);
    if ("refusal" in resolved) {
      await post(client, msg, resolved.refusal);
      return;
    }
    const result = await sendChat(resolved.value, msg.text); // same brain, history, tools, permissions
    await post(client, msg, toMrkdwn(result.reply));
  } catch (error) {
    // Log AND post (spec §5.4). Never log message text (telemetry-privacy rule) —
    // record the error class and the Slack user id only.
    console.error(
      JSON.stringify({
        level: "error",
        message: "slack handler failed",
        slackUser: msg.user,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    await best(() =>
      post(client, msg, "Something went wrong while handling your message. Please try again."),
    );
  } finally {
    await best(() =>
      client.reactions.remove({ channel: msg.channel, timestamp: msg.ts, name: "hourglass_flowing_sand" }),
    );
  }
}

export const stripMentions = (t: string) => (t ?? "").replace(/<@[^>]+>/g, "").trim();

const post = (client: WebClient, msg: IncomingMsg, text: string) =>
  client.chat.postMessage({ channel: msg.channel, thread_ts: msg.threadTs, text });

const best = (fn: () => Promise<unknown>) => fn().catch(() => undefined); // reactions are best-effort
