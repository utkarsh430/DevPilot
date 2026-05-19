// The pure half of "ask a human for a secret": what counts as a valid request.
//
// Split out of `request-secrets.ts` because that module reaches
// `transitionTicket` and `supabaseService`, which pull `server-only` and cannot
// load under Vitest at all — so validation left inside it would be validation
// that cannot be tested. Same split, and the same reason, as
// `lib/learning/write.ts` beside its action wrapper.
//
// This is also the module the Vercel env-push action imports for `SECRET_KEY_RE`,
// so an env var name coming back from the browser is checked against exactly the
// shape the ask loop enforces, rather than a second regex that could drift.

/** Bounded because these names are rendered as form fields and, on the runner
 *  path, originate with an agent. Eight is enough for a real dependency set and
 *  small enough that the resulting form stays readable. */
export const MAX_SECRET_REQUEST_KEYS = 8;

/** The shape `project_secrets` and `.env.example` both use. A name that fails
 *  this cannot have come from a real declaration, and must never reach a Vercel
 *  request body or a form field. */
export const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

/** Comment author id shape — a role slug on the agent path. */
export const ROLE_SLUG_RE = /^[a-z][a-z0-9_]{0,63}$/;

export type NormalizedSecretRequest =
  | { ok: true; ticketId: string; keys: string[]; rationale: string; authorId: string }
  | { ok: false; error: string };

/**
 * Validate and normalise a secret request.
 *
 * Rejects rather than sanitises. Rewriting an out-of-shape name into a legal one
 * would mean asking the operator for a variable nobody actually declared, under
 * a name DevPilot invented — and the whole point of this loop is that the human
 * is looking at the real thing.
 */
export function normalizeSecretRequest(input: {
  ticketId?: unknown;
  keys?: unknown;
  rationale?: unknown;
  authorId?: unknown;
}): NormalizedSecretRequest {
  if (typeof input.ticketId !== "string" || input.ticketId.trim().length === 0) {
    return { ok: false, error: "ticketId required" };
  }
  if (!Array.isArray(input.keys) || input.keys.length === 0) {
    return { ok: false, error: "keys must be a non-empty array" };
  }
  if (input.keys.length > MAX_SECRET_REQUEST_KEYS) {
    return { ok: false, error: `at most ${MAX_SECRET_REQUEST_KEYS} keys per request` };
  }
  const keys: string[] = [];
  for (const raw of input.keys) {
    if (typeof raw !== "string") return { ok: false, error: "keys must be strings" };
    const trimmed = raw.trim();
    if (!SECRET_KEY_RE.test(trimmed)) {
      return { ok: false, error: `invalid key shape (must be UPPER_SNAKE_CASE): ${raw}` };
    }
    keys.push(trimmed);
  }
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (rationale.length === 0) return { ok: false, error: "rationale required" };

  const authorId =
    typeof input.authorId === "string" && ROLE_SLUG_RE.test(input.authorId)
      ? input.authorId
      : "claude";

  return { ok: true, ticketId: input.ticketId, keys, rationale, authorId };
}
