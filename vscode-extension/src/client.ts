// HTTP client for the local backend. Loopback only; no cloud endpoints.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const DEFAULT_BACKEND_URL = "http://127.0.0.1:8765";
export const DEFAULT_TIMEOUT_MS = 130000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 180000;

export class BackendError extends Error {}

export interface ChatResult {
  requestId: string;
  reply: string;
}

export function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

/** Returns the base URL without a trailing slash, or throws BackendError if not an http loopback URL. */
export function validateBackendUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BackendError(`Invalid backend URL: "${raw}".`);
  }
  if (url.protocol !== "http:") {
    throw new BackendError(`Backend URL must use http (got "${url.protocol}").`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new BackendError(
      `Backend URL host "${url.hostname}" is not loopback. Only 127.0.0.1, localhost or [::1] are allowed.`
    );
  }
  if (url.username || url.password) {
    throw new BackendError("Backend URL must not contain credentials.");
  }
  return url.origin;
}

export async function postChat(
  baseUrl: string,
  message: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ChatResult> {
  const origin = validateBackendUrl(baseUrl);
  const timeout = normalizeTimeout(timeoutMs);

  const timeoutError = () => new BackendError(`Backend did not respond within ${timeout} ms (${origin}).`);
  const signal = AbortSignal.timeout(timeout);

  let response: Response;
  try {
    response = await fetch(`${origin}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal,
      redirect: "error",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw timeoutError();
    }
    throw new BackendError(`Cannot reach backend at ${origin}. Is it running?`);
  }

  // The same signal also covers the response body, so a stalled body is a timeout, not bad JSON.
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw timeoutError();
    }
    throw new BackendError("Connection to backend was lost while reading the response.");
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackendError(
      response.ok
        ? "Backend returned a malformed (non-JSON) response."
        : `Backend error: HTTP ${response.status}.`
    );
  }

  if (!response.ok) {
    const e = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const rid = (data as { request_id?: unknown } | null)?.request_id;
    if (e && typeof e.message === "string") {
      const suffix = typeof rid === "string" ? ` [request ${rid}]` : "";
      throw new BackendError(`Backend error (${response.status}): ${e.message}${suffix}`);
    }
    throw new BackendError(`Backend error: HTTP ${response.status}.`);
  }

  const d = data as { request_id?: unknown; reply?: unknown } | null;
  if (!d || typeof d.reply !== "string" || typeof d.request_id !== "string") {
    throw new BackendError("Backend returned a malformed response.");
  }
  return { requestId: d.request_id, reply: d.reply };
}
