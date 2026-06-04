// A BOUNDED `inngest.send`.
//
// WHY THIS EXISTS (2026-08-01, live). `inngest.send()` ends in a `fetch` with no
// timeout and no AbortSignal. When the event endpoint accepts the connection but
// never answers - the exact state a local Inngest dev server reached after 14
// days against a web server that had been restarted underneath it, alive as a
// process while `curl http://localhost:8288/` returned HTTP 000 after 6s,
// repeatedly - the returned promise NEVER SETTLES. It does not reject, so a
// surrounding `try/catch` never runs and every statement after the emit is
// simply never executed.
//
// That defeated "Discard & restart from dev", whose cleanup emit is explicitly
// documented as best-effort ("a failed cleanup emit must not block the reset"):
// the operator held a "Discarding…" spinner indefinitely while the ticket was
// never reset, no pending pushes were discarded and no workspace wipe was
// queued - with no way to tell whether the action had partially applied.
//
// A HANG IS NOT AN ERROR. Wrapping a call in `try/catch` does not bound it, and
// no amount of error handling downstream can help a statement that is never
// reached. The only fix is to bound the wait.
//
// WHAT THIS CHANGES, AND ONLY THIS. `sendEventBounded` behaves exactly like
// `inngest.send` except that it FAILS instead of hanging. Every call site keeps
// the error handling it already had: the best-effort catches now actually run,
// and the sites that report `event dispatch failed` now report it. No control
// flow is restructured anywhere, which is what makes this safe to apply across
// ~25 call sites in one change.
//
// SCOPE - REQUEST PATHS ONLY. Every `inngest.send` reachable from a server
// action or a route handler goes through this, because something is blocked on
// the HTTP response and nothing else will ever un-block it. Sends that happen
// only INSIDE an Inngest durable function are deliberately left alone: Inngest
// already bounds a step with its own timeout and retries it, so a second,
// shorter bound there would only convert a slow-but-healthy send into a
// spurious step failure. See `__tests__/bounded-send-wiring.test.ts` for the
// enforced list.
//
// A TIMED-OUT SEND MAY STILL BE DELIVERED. `inngest.send` takes no AbortSignal,
// so the bound is a RACE, not a cancellation: the underlying request can still
// land after we have given up on it. Every bounded event must therefore be safe
// to receive late - they all are, being either best-effort notifications or
// idempotent dispatch/pump events. Do NOT route an emit through here whose late
// or duplicate delivery would be harmful; bound that one at the transport
// instead.

import { inngest } from "@/lib/engine/inngest";

/**
 * 5 seconds.
 *
 * A healthy Inngest accepts an event in well under a second - the dev server in
 * the incident above answered in 0.5ms once restarted - so this is roughly four
 * orders of magnitude of headroom. The bound therefore only fires when the
 * endpoint is genuinely unresponsive, a state in which the unbounded call would
 * not have succeeded either; it is not a latency budget and must not be tuned
 * like one. It is also short enough that an operator watching a spinner gets an
 * answer instead of an indefinite wait.
 *
 * Deliberately a CODE CONSTANT, not an env var. This repo configures call
 * timeouts in code (`generateObjectForTenant`'s `timeoutMs`), there is no
 * convention for per-call timeout env vars, and an operator-tunable bound on a
 * failure path invites being raised until it is a hang again.
 */
export const EVENT_SEND_TIMEOUT_MS = 5_000;

/** Thrown when a bounded send does not settle inside its timeout. Distinguishable
 *  from a transport error on purpose - the send may yet be delivered. */
export class EventSendTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(
      `inngest send "${label}" did not complete within ${timeoutMs}ms - the event endpoint is ` +
        `accepting connections but not responding. The event may still be delivered.`,
    );
    this.name = "EventSendTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `work` with a hard ceiling, rejecting with `EventSendTimeoutError` when it
 * expires.
 *
 * The general primitive behind `sendEventBounded`, exported so a call site that
 * is blocked on a COMPOUND step (a DB read plus an emit - see
 * `requestWorkspaceReset`) can bound the whole thing it is actually waiting on
 * rather than just the last hop.
 */
export async function withSendTimeout<T>(
  work: () => Promise<T>,
  opts: { label: string; timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? EVENT_SEND_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new EventSendTimeoutError(opts.label, timeoutMs)),
          timeoutMs,
        );
        // A pending bound must never be the reason a process stays alive.
        timer.unref?.();
      }),
    ]);
  } finally {
    // Clear on EVERY exit, including the success path - otherwise a healthy send
    // leaves a live timer behind for the full timeout on every request.
    if (timer) clearTimeout(timer);
  }
}

type SendPayload = Parameters<typeof inngest.send>[0];
type SendResult = Awaited<ReturnType<typeof inngest.send>>;

/** The event name(s) in a payload, for the timeout message. Never throws - this
 *  runs on the failure path and must not turn a timeout into a TypeError. */
function describePayload(payload: SendPayload): string {
  const named = (e: unknown): string =>
    typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string"
      ? (e as { name: string }).name
      : "(unnamed)";
  if (Array.isArray(payload)) {
    return payload.length === 0 ? "(empty batch)" : payload.map(named).join(", ");
  }
  return named(payload);
}

/**
 * `inngest.send`, bounded. Drop-in: same payload, same return value, same
 * failure semantics as a transport error - it just cannot hang.
 */
export async function sendEventBounded(
  payload: SendPayload,
  opts?: { timeoutMs?: number },
): Promise<SendResult> {
  return withSendTimeout(() => inngest.send(payload), {
    label: describePayload(payload),
    timeoutMs: opts?.timeoutMs,
  });
}
