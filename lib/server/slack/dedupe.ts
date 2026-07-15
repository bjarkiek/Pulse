// In-memory de-duplication window for inbound Slack events.
//
// Slack retries event deliveries (e.g. on slow acks), so handlers key each
// event (typically "<channel>:<event_ts>" or the top-level "event_id") and
// call isDuplicate() before doing any work. Entries live for 15 minutes,
// which comfortably covers Slack's retry window without growing unbounded.

declare global {
  var pulseSlackDedupe: Map<string, number> | undefined;
}

const WINDOW_MS = 15 * 60_000;

export function isDuplicate(key: string): boolean {
  const map = (globalThis.pulseSlackDedupe ||= new Map());
  const now = Date.now();
  for (const [k, expiresAt] of map) if (expiresAt <= now) map.delete(k);
  if (map.has(key)) return true;
  map.set(key, now + WINDOW_MS);
  return false;
}
