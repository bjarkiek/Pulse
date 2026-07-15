import type { PulseIdentity, Tone } from "@/lib/domain";
import { requireMembership } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { listIdeas } from "./idea-repository";
import { listRequests } from "./request-repository";

type SearchCandidate = {
  id: string;
  title: string;
  description: string;
  area: string;
  status: string;
  tone: Tone;
  source: "Idea" | "Your request";
};

function tokens(value: string) {
  return value
    .toLocaleLowerCase("en")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length > 2)
    .map((token) => token.replace(/(ing|ed|es|s)$/u, ""));
}

function distance(left: string, right: string) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let prior = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const saved = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        prior + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      prior = saved;
    }
  }
  return row[right.length];
}

function rank(candidate: SearchCandidate, query: string, area?: string) {
  const queryTokens = tokens(query);
  const candidateTokens = tokens(
    `${candidate.title} ${candidate.description} ${candidate.area}`,
  );
  const matched: string[] = [];
  let score = area && candidate.area === area ? 1.5 : 0;
  for (const queryToken of queryTokens) {
    let best = 0;
    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) best = Math.max(best, 3);
      else if (
        candidateToken.startsWith(queryToken) ||
        queryToken.startsWith(candidateToken)
      )
        best = Math.max(best, 2);
      else if (
        queryToken.length >= 5 &&
        distance(queryToken, candidateToken) <=
          Math.max(1, Math.floor(queryToken.length / 5))
      )
        best = Math.max(best, 1.25);
    }
    if (best) matched.push(queryToken);
    score += best;
  }
  return { score, matched };
}

export async function searchSuggestions(
  identity: PulseIdentity,
  query: string,
  area?: string,
) {
  await requireMembership(identity);
  const trimmed = query.trim().slice(0, 500);
  if (trimmed.length < 3) return [];
  const [ideas, requests] = await Promise.all([
    listIdeas(identity),
    listRequests(identity),
  ]);
  const candidates: SearchCandidate[] = [
    ...ideas.map((idea) => ({
      id: idea.id,
      title: idea.title,
      description: idea.description,
      area: idea.area,
      status: idea.status,
      tone: idea.tone,
      source: "Idea" as const,
    })),
    ...requests.map((request) => ({
      id: request.id,
      title: request.title,
      description: request.problem,
      area: request.area,
      status: request.status,
      tone: request.tone,
      source: "Your request" as const,
    })),
  ];
  return candidates
    .map((candidate) => ({ ...candidate, ...rank(candidate, trimmed, area) }))
    .filter((candidate) => candidate.score >= 1.25)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      description: candidate.description,
      area: candidate.area,
      status: candidate.status,
      tone: candidate.tone,
      source: candidate.source,
      why:
        candidate.matched.length > 0
          ? `Matches ${candidate.matched.slice(0, 3).join(", ")}`
          : `Shared product area: ${candidate.area}`,
    }));
}

export async function recordSuggestionDismissal(
  identity: PulseIdentity,
  input: { queryLength: number; suggestionIds: string[] },
) {
  await requireMembership(identity);
  const safe = {
    queryLength: Math.min(Math.max(Number(input.queryLength) || 0, 0), 500),
    suggestionCount: Math.min(input.suggestionIds?.length || 0, 5),
  };
  if (!isAzureSqlConfigured()) {
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      organizationId: identity.organizationId,
      action: "search.suggestions-dismissed",
      entityType: "Search",
      after: safe,
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return { recorded: true };
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, crypto.randomUUID())
    .input("actor", sql.UniqueIdentifier, identity.id)
    .input("organizationId", sql.NVarChar(32), identity.organizationId)
    .input("after", sql.NVarChar(sql.MAX), JSON.stringify(safe))
    .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
    .query(
      "INSERT dbo.AuditEvents(id,actor_user_id,organization_id,action,entity_type,after_json,correlation_id) VALUES(@id,@actor,@organizationId,'search.suggestions-dismissed','Search',@after,@correlation)",
    );
  return { recorded: true };
}
