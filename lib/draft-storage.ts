const PREFIX = "pulse-draft-v2:";
const TTL = 24 * 60 * 60 * 1000;

export function readDeviceDraft(scope: string | null): string | null {
  if (!scope) return null;
  try {
    localStorage.removeItem("pulse-request-draft"); // never restore unscoped legacy data
    const saved = localStorage.getItem(PREFIX + scope);
    if (!saved) return null;
    const envelope = JSON.parse(saved);
    if (
      !Number.isFinite(envelope.expires) ||
      envelope.expires <= Date.now() ||
      typeof envelope.value !== "string"
    ) {
      localStorage.removeItem(PREFIX + scope);
      return null;
    }
    return envelope.value;
  } catch {
    return null;
  }
}
export function saveDeviceDraft(scope: string | null, value: string): boolean {
  if (!scope) return false;
  try {
    localStorage.setItem(
      PREFIX + scope,
      JSON.stringify({ expires: Date.now() + TTL, value }),
    );
    return true;
  } catch {
    return false;
  }
}
export function removeDeviceDraft(scope: string | null) {
  try {
    if (scope) localStorage.removeItem(PREFIX + scope);
  } catch {
    /* storage can be disabled */
  }
}
export function clearDeviceDrafts() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(PREFIX) || key === "pulse-request-draft"))
        localStorage.removeItem(key);
    }
  } catch {
    /* storage can be disabled */
  }
}
