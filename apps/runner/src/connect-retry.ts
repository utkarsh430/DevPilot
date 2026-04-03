// Boot-time resilience for engine calls that race the engine's own startup.
//
// On a cold `pnpm dev`, turbo starts the runner and the Next.js engine in
// parallel. The runner frequently wins the race and makes its boot-time
// registerRunner() call before Next.js has bound :3000, so node's `fetch`
// rejects with ECONNREFUSED (surfaced as `TypeError: fetch failed`). That is
// transient — the engine is seconds away from listening — so we retry with
// bounded backoff instead of fatal-exiting.
//
// The critical distinction: a `fetch` that rejects BEFORE any HTTP response
// (connection refused / reset / DNS) is transient and retryable. An error that
// arrives AFTER a TCP connection — a 401/403 response, a malformed body — is a
// real engine problem and must surface immediately, never be retried. This
// module holds no engine/env dependencies so it stays unit-testable in
// isolation (see connect-retry.test.ts).

// Underlying error codes that mean "the connection never completed". Node's
// fetch wraps these on the `.cause` of the thrown `TypeError`, sometimes inside
// an AggregateError (`.errors`).
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * True when `err` represents a failure to establish/complete the HTTP
 * connection (engine not listening yet), as opposed to an HTTP response the
 * engine actually returned. Walks the `cause` chain and any AggregateError
 * `errors` array so a deeply-wrapped ECONNREFUSED is still recognised.
 */
export function isTransientConnectError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (e: unknown): boolean => {
    if (e == null || typeof e !== "object" || seen.has(e)) return false;
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return true;
    // node's fetch rejects with `TypeError: fetch failed` when the request
    // never got a response. That signature alone means "no HTTP response",
    // which is exactly the transient class we retry on.
    if (e instanceof TypeError && /fetch failed/i.test((e as Error).message)) return true;
    const nested = (e as { errors?: unknown }).errors;
    if (Array.isArray(nested) && nested.some(visit)) return true;
    return visit((e as { cause?: unknown }).cause);
  };
  return visit(err);
}

export type RetryOnConnectOptions = {
  /** Backoff before the first retry (doubles each attempt). Default 500ms. */
  initialDelayMs?: number;
  /** Cap on any single backoff interval. Default 5s. */
  maxDelayMs?: number;
  /** Overall wall-clock ceiling; once exceeded we stop and rethrow. Default 2min. */
  overallTimeoutMs?: number;
  /** Invoked before each backoff wait so the caller can log why it is waiting. */
  onWait?: (info: { attempt: number; delayMs: number; elapsedMs: number; err: unknown }) => void;
  /** Injectable for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
};

/**
 * Run `attempt`, retrying with capped exponential backoff for as long as it
 * fails with a transient connect error. A non-transient failure (a real HTTP
 * response, a malformed body, any other throw) is rethrown immediately. If the
 * overall timeout is exhausted while still failing transiently, the last error
 * is rethrown so the caller can fail loudly.
 */
export async function retryOnTransientConnect<T>(
  attempt: () => Promise<T>,
  options: RetryOnConnectOptions = {},
): Promise<T> {
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const overallTimeoutMs = options.overallTimeoutMs ?? 120_000;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  const start = now();
  let delay = initialDelayMs;
  let attemptNo = 0;
  for (;;) {
    attemptNo++;
    try {
      return await attempt();
    } catch (err) {
      // Genuine engine responses / any non-connect failure surface at once.
      if (!isTransientConnectError(err)) throw err;
      const elapsedMs = now() - start;
      // Give up (and rethrow) once we've spent the overall budget still failing
      // to connect — the engine is genuinely not coming up.
      if (elapsedMs >= overallTimeoutMs) throw err;
      options.onWait?.({ attempt: attemptNo, delayMs: delay, elapsedMs, err });
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
