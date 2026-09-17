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
export function errorMessage(error: unknown) {
  return error instanceof ApiFailure
    ? `${error.message}${error.supportId ? ` Support ID: ${error.supportId}` : ""}`
    : "Unable to connect. Your input is still here; please retry.";
}
