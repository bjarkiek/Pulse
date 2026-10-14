export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    public supportId?: string,
  ) {
    super(
      status === 401
        ? "Your session expired. Your input is still here. Sign in and retry."
        : status === 412
          ? "This item changed. Reload it and review the latest version before saving."
          : status === 428
            ? "Reload this item before saving."
            : "The operation failed. Please try again.",
    );
  }
}
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiFailure(
      response.status,
      data?.error?.code || "REQUEST_FAILED",
      response.headers.get("x-correlation-id") || undefined,
    );
  return data as T;
}
/** What a refused request (a 400) means in words, for the codes whose cause the person at the screen can act on. */
const REFUSALS: Record<string, string> = {
  INVALID_SAFE_MODE_BLOCKS_RECIPIENT:
    "Safe mode is on and your address's domain is not allow-listed.",
  INVALID_EMAIL_PROVIDER_CONFIGURATION:
    "SendGrid is not configured: add the API key and a verified from address.",
  INVALID_COMMUNICATIONS_DISABLED: "Sending is disabled in Settings.",
  INVALID_AUDIENCE_EMPTY: "Nobody matches this audience.",
  INVALID_AUDIENCE_TOO_LARGE:
    "This audience exceeds the maximum recipients per communication.",
  INVALID_SCHEDULE_TIME:
    "Choose a time at least one minute ahead and within 30 days.",
  INVALID_COMMUNICATION_STATE:
    "This communication is no longer in a state that allows that action.",
  INVALID_CONTACT_EXISTS: "That address is already on this company's list.",
  INVALID_INPUT: "Some fields are missing or invalid.",
  INVALID_COMMUNICATION_NOT_EDITABLE:
    "This communication is no longer a draft and cannot be edited.",
  INVALID_COMMUNICATION_NOT_DELETABLE:
    "Only drafts, and cancelled communications that sent nothing, can be deleted.",
  INVALID_UNSUBSCRIBE_GROUP_REQUIRED:
    "Set the SendGrid unsubscribe group before leaving safe mode.",
  INVALID_TEMPLATE: "Unknown template.",
};

/** What the codes of a refusal start with: a request that was not valid, and one against a mandatory rule (`apiError` answers both with a 400). */
const REFUSAL_PREFIXES = ["INVALID_", "MANDATORY_"];

/**
 * The sentence for a failure. A 400 is the server explaining a refusal with a code: the sentence written for the code, else the words of
 * the code itself ("INVALID_FOO_BAR" is "Foo bar.", and so is "MANDATORY_FOO_BAR"). Any other failure keeps the text it was built with.
 */
function failureSentence(error: ApiFailure) {
  if (error.status !== 400) return error.message;
  if (Object.hasOwn(REFUSALS, error.code)) return REFUSALS[error.code];
  const prefix = REFUSAL_PREFIXES.find((candidate) =>
    error.code.startsWith(candidate),
  );
  const words = prefix
    ? error.code
        .slice(prefix.length)
        .toLowerCase()
        .split("_")
        .filter(Boolean)
        .join(" ")
    : "";
  return words ? `${words[0].toUpperCase()}${words.slice(1)}.` : error.message;
}

export function errorMessage(error: unknown) {
  return error instanceof ApiFailure
    ? `${failureSentence(error)}${error.supportId ? ` Support ID: ${error.supportId}` : ""}`
    : "Unable to connect. Your input is still here; please retry.";
}
