import type { PulseIdentity } from "@/lib/domain";
import {
  buildAssistantInstructions,
  type IdentityContext,
} from "./tool-registry";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * ISO 8601 week number (weeks start Monday, week 1 contains the year's
 * first Thursday). Computed on UTC calendar fields to stay independent of
 * server timezone.
 */
function isoWeek(date: Date): number {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7; // Monday=1 .. Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function todayLine(now = new Date()): string {
  const isoDate = now.toISOString().slice(0, 10);
  const weekday = WEEKDAYS[now.getDay()];
  return `Today is ${isoDate} (${weekday}, ISO week ${isoWeek(now)}).`;
}

const BEHAVIOR = `Behavior:
- Reply in the SAME language the user writes in (English and Icelandic are common).
- Use the tools to actually perform what the user asks — don't just describe what could be done.
- Resolve relative dates ("today", "last week", "next Monday") yourself from today's date; weeks start on Monday.
- ALWAYS call find_similar and surface possible duplicates before creating a new request.
- Before destructive or high-blast actions (merging ideas, publishing ideas or releases, bulk triage
  over many requests, changing settings), confirm with the user first. Single adds/edits the user
  clearly requested may proceed directly.
- If a request is ambiguous, ask one short clarifying question.
- Be concise. After acting, summarize what changed in one or two sentences.`;

export function buildSystemPrompt(
  identity: PulseIdentity,
  context: IdentityContext,
): string {
  return [buildAssistantInstructions(identity, context), todayLine(), BEHAVIOR].join(
    "\n\n",
  );
}
