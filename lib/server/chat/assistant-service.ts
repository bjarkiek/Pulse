import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import type { PulseIdentity } from "@/lib/domain";
import { getIdentityContext } from "../identity-repository";
import { requireMembership } from "../authorization";
import { appendChatMessage, getChatHistory } from "./chat-repository";
import { getChatTools, chatToolErrorMessage } from "./tool-registry";
import { buildSystemPrompt } from "./system-prompt";

declare global {
  var pulseAnthropicClient: { key: string; client: Anthropic } | undefined;
}

export function isAssistantConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY!;
  if (globalThis.pulseAnthropicClient?.key !== key)
    globalThis.pulseAnthropicClient = { key, client: new Anthropic({ apiKey: key }) };
  return globalThis.pulseAnthropicClient.client; // one client (and HTTP agent) per process — never per request
}

const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

type ChatToolState = { dataChanged: boolean; switchedOrganizationId?: string };

// Adapt the neutral registry to Anthropic runnable tools, bound to THIS request's
// mutable identity + state. Group gating is prompt hygiene; repos are the braces.
function buildRunnerTools(
  identity: PulseIdentity,
  groups: Set<string>,
  state: ChatToolState,
): BetaRunnableTool<Record<string, unknown>>[] {
  const tools = getChatTools()
    .filter((t) => groups.has(t.group))
    .map((t) =>
      betaZodTool({
        name: t.name,
        description: t.description,
        inputSchema: z.object(t.inputSchema),
        run: async (input: Record<string, unknown>) => {
          try {
            const text = await t.run(identity, input);
            if (!t.readOnly) state.dataChanged = true;
            return text;
          } catch (error) {
            return chatToolErrorMessage(error);
          }
        },
      }),
    );
  // Chat-host-only tool: durable org switching (cookie side effect in the route).
  // Its input shape ({organizationId}) is narrower than the registry tools'
  // Record<string, unknown>, so the array element type is widened explicitly.
  tools.push(
    betaZodTool({
      name: "switch_organization",
      description:
        "Switch the user's active organization. On the web app this persists; pass organization_id on individual tools to act in a specific org. Use get_me to list memberships.",
      inputSchema: z.object({ organizationId: z.string().max(32) }),
      run: async ({ organizationId }: { organizationId: string }) => {
        try {
          await requireMembership({ ...identity }, organizationId);
          identity.organizationId = organizationId;
          state.switchedOrganizationId = organizationId;
          state.dataChanged = true;
          return `Active organization switched to ${organizationId}.`;
        } catch (error) {
          return chatToolErrorMessage(error);
        }
      },
    }) as unknown as BetaRunnableTool<Record<string, unknown>>,
  );
  return tools;
}

export async function sendChat(identity: PulseIdentity, text: string) {
  if (!isAssistantConfigured())
    return {
      reply:
        "The assistant isn't configured yet. Ask an administrator to set ANTHROPIC_API_KEY.",
      dataChanged: false,
    };

  const context = await getIdentityContext(identity); // FORBIDDEN for unknown/inactive users → route maps via apiError
  await appendChatMessage(identity, "user", text);
  const history = await getChatHistory(identity, 30); // includes the message just persisted
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  while (messages.length && messages[0].role !== "user") messages.shift(); // first message must be user

  // Membership objects are { id, name, type, role, active }; the query already
  // filters to Active memberships, so no status field exists to check.
  const internal = context.organizations.find((o) => o.type === "Internal");
  const groups = new Set<string>(["customer"]);
  if (internal) groups.add("internal");
  if (internal?.role === "System admin") groups.add("admin");

  const state: ChatToolState = { dataChanged: false };
  const requestIdentity: PulseIdentity = {
    ...identity,
    organizationId: context.activeOrganizationId ?? identity.organizationId,
  };

  let reply: string;
  try {
    const finalMessage = await getClient().beta.messages.toolRunner({
      model: MODEL(),
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      system: buildSystemPrompt(requestIdentity, context),
      messages,
      tools: buildRunnerTools(requestIdentity, groups, state),
      max_iterations: 16,
    });
    reply =
      finalMessage.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim() || "(no reply)";
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.warn(
        JSON.stringify({ level: "warn", message: "assistant api error", status: error.status }),
      );
      reply =
        "The assistant ran into a problem completing that request. Please try again in a moment.";
    } else {
      console.error(
        JSON.stringify({ level: "error", message: "assistant unexpected error" }),
      );
      reply = "The assistant hit an unexpected error. Please rephrase and try again.";
    }
  }

  await appendChatMessage(identity, "assistant", reply);
  return { reply, dataChanged: state.dataChanged, switchedOrganizationId: state.switchedOrganizationId };
}

const CLEAN_SYSTEM =
  "You clean up voice-dictation transcripts. Fix punctuation, casing and obvious mis-transcriptions, " +
  "remove filler words and repetitions, but keep the language, meaning and all specifics " +
  "(dates, numbers, names) exactly. Reply with ONLY the cleaned text.";

export async function cleanTranscript(raw: string): Promise<string> {
  if (!isAssistantConfigured() || !raw.trim()) return raw;
  try {
    const res = await getClient().messages.create({
      model: MODEL(),
      max_tokens: 500,
      system: CLEAN_SYSTEM,
      messages: [{ role: "user", content: raw }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || raw;
  } catch {
    console.warn(JSON.stringify({ level: "warn", message: "transcript cleanup failed" }));
    return raw;
  }
}
