// WI-14 - pure guardrails for agent-filed tickets (`devpilot_create_ticket`).
//
// The route that calls these is a runner-authed write that creates work an
// operator can later promote into a billable run, so it carries the same class
// of risk as `devpilot_spawn_agent`. Everything decidable without IO lives here so
// it is unit-testable in isolation; the IO (the durable slot claim, the
// candidate read) lives in `agent-ticket.server.ts`.
//
// The refusal codes are structured (not prose) for the same reason
// `SpawnRefused` is: the agent sees them as a tool_result and its system prompt
// can tell it what to do about each one - reduce scope at the cap, stop filing
// duplicates - rather than retrying the same call forever.

/** Agent-supplied text is UNTRUSTED (AGENTS.md principle 6) and length-bounded
 *  at the same limits the human board form uses (`CreateTicketInput`). Anything
 *  over the bound is a hard refusal, not a silent truncation: a truncated title
 *  is a different ticket than the one the agent meant to file. */
export const AGENT_TITLE_MAX_CHARS = 200;
export const AGENT_TITLE_MIN_CHARS = 3;
export const AGENT_DESCRIPTION_MAX_CHARS = 8_000;

/**
 * How many tickets ONE run may file. CLAUDE.md §3 - hard ceilings everywhere.
 * Sized like the spawn caps: low enough that a confused agent can't paper the
 * board, high enough for the ORDINARY case (an engineer notices two or three
 * genuinely out-of-scope things while doing its ticket).
 *
 * It is the ordinary case only. A DECOMPOSITION ticket - one whose acceptance
 * criteria are "break this into child tickets" - legitimately fans out to five
 * or more, and a single instance-wide number cannot serve both shapes: sized for
 * the engineer it strands the decomposition halfway, sized for the
 * decomposition it stops bounding the engineer. Hence the per-project rung
 * below.
 */
export const DEFAULT_MAX_TICKETS_PER_RUN = 3;

/** Which rung of the chain supplied the ceiling. Carried into the refusal copy
 *  so the agent's escalation names the control an operator should actually
 *  change - a per-project ceiling and an instance-wide one live in different
 *  places, and "raise the limit" without saying where is what cost a full human
 *  round-trip on 2026-08-02. */
export type MaxTicketsSource = "project" | "env" | "default";

export type ResolvedMaxTickets = { max: number; source: MaxTicketsSource };

/**
 * One rung of the ceiling chain. Returns null for "this rung says nothing",
 * which is what makes the fallback a CHAIN rather than a cliff: a rung that is
 * unset, non-numeric, or below 1 is skipped and the next one is consulted.
 *
 * A safety ceiling must never be switch-off-able by a typo, so there is no
 * input - not `0`, not `""`, not `"off"`, not a negative - that disables the
 * cap. The worst a bad value can do is fall through to a stricter rung.
 *
 * Deliberately tolerant of `number` as well as `string`: the project rung
 * arrives as an int column via `mapProjectRow`, which also maps the
 * `shell_bootstrap` RPC's jsonb, where an unexpected value must degrade rather
 * than crash (the same posture as `projectType` / `stackEcosystem` there).
 */
export function normalizeTicketCeiling(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

/**
 * Resolve the per-run ticket ceiling: **project » env » default**.
 *
 * Both fields are REQUIRED rather than optional. Optional is what a call site
 * forgets, and a forgotten project rung is invisible - the cap still works, it
 * just silently ignores the setting the operator changed. Required makes a new
 * call site a compile error until it decides what to pass.
 *
 * No absolute upper bound is imposed, deliberately: `DEVPILOT_MAX_TICKETS_PER_RUN`
 * has never had one, and adding a ceiling-on-the-ceiling here would silently
 * shrink a live instance-wide configuration nobody asked us to change. The
 * project rung is bounded at the storage layer instead (`check >= 1`), and both
 * rungs are operator-set - the cap exists to bound a confused AGENT, not an
 * operator who typed a large number on purpose.
 */
export function resolveMaxTicketsPerRun(input: {
  /** `projects.agent_ticket_max_per_run` - NULL means "inherit". */
  project: number | string | null | undefined;
  /** `process.env.DEVPILOT_MAX_TICKETS_PER_RUN` - the instance-wide rung. */
  env: string | undefined;
}): ResolvedMaxTickets {
  const project = normalizeTicketCeiling(input.project);
  if (project !== null) return { max: project, source: "project" };

  const env = normalizeTicketCeiling(input.env);
  if (env !== null) return { max: env, source: "env" };

  return { max: DEFAULT_MAX_TICKETS_PER_RUN, source: "default" };
}

export type AgentTicketRefusalCode =
  /** The run's DEVPILOT_RUN_ID / DEVPILOT_TICKET_ID was missing - a ticket-less run
   *  (e.g. a supervisor's ad-hoc child) has no project to file into. */
  | "no-ticket-context"
  /** `projects.agent_ticket_creation` is off for this ticket's project. */
  | "not-enabled"
  /** The run has already filed DEVPILOT_MAX_TICKETS_PER_RUN tickets. */
  | "ticket-cap"
  /** An open ticket with the same normalized title already exists. */
  | "duplicate"
  /** Title/description/alias/dependsOn failed the shape or length bounds. */
  | "invalid-input"
  /** A `dependsOn` entry named no ticket in this project. Defined here rather
   *  than only in `ticket-deps.ts` so the route's refusal codes are one closed
   *  union - an agent's prompt reasons over this list, and a code that exists in
   *  only half of it is a code nothing can be told what to do about. */
  | "unknown-blocker"
  /** The alias is already in use by another ticket this run filed. */
  | "duplicate-alias"
  /** The declared edge would close a dependency loop. */
  | "dependency-cycle";

export type AgentTicketRefusal = { code: AgentTicketRefusalCode; reason: string };

// ---------------------------------------------------------------------------
// Refusal COPY.
//
// These strings are not decoration - they are the documentation, and they are
// the whole reason this file changed. A refusal is delivered to the agent as a
// tool_result; the agent, having nothing else to go on, quotes it into a
// `devpilot_request_human` escalation, and THAT is the only text the operator
// ever sees. So the refusal must name the exact control and where it lives, or
// the operator has to go and read the source to find out what stopped their
// agent. That is not hypothetical: on 2026-08-02 a decomposition ticket was
// refused with "report the out-of-scope work in a comment instead", which named
// neither the setting nor the page, and cost a full human round-trip plus a
// wasted run to resolve.
//
// The labels below are the literal strings the UI renders, so the agent's
// escalation and the operator's screen agree word for word.
// ---------------------------------------------------------------------------

/** The label on the enable switch, verbatim as `AgentAutonomyCard` renders it. */
export const AGENT_TICKET_ENABLE_LABEL = 'Agent autonomy → "File tickets for new work"';

/** The label on the per-project ceiling field, verbatim as the card renders it. */
export const AGENT_TICKET_CAP_LABEL = 'Agent autonomy → "Tickets one run may file"';

/** Where both controls live. The id is derived server-side from the SPAWNING
 *  ticket, never from the agent, so this is safe to render into agent-visible
 *  text - and a bare "the project page" would make the operator hunt. */
export function agentTicketSettingsPath(projectId: string): string {
  return `/projects/${projectId}`;
}

/** `projects.agent_ticket_creation` is off. Names the switch and the page, and
 *  tells the agent to say WHICH tool it was refused - otherwise the operator
 *  gets an escalation about missing work with no clue which setting produced
 *  it. */
export function describeNotEnabledRefusal(projectId: string): AgentTicketRefusal {
  return {
    code: "not-enabled",
    reason:
      "Filing new tickets is not enabled for this project, so nothing was created. " +
      `An operator can turn it on at ${AGENT_TICKET_ENABLE_LABEL}, on the project page ` +
      `(${agentTicketSettingsPath(projectId)}). ` +
      "Until then: put the full title and description of every ticket you wanted to file " +
      "into a comment on your current ticket, and state that devpilot_create_ticket was " +
      "refused because that setting is off, so whoever reads it knows what to change. " +
      "Do not report this work as filed - it does not exist.",
  };
}

/**
 * The run has spent its ceiling.
 *
 * The single most important property of this copy is that hitting the cap must
 * be UNMISTAKABLE, because the failure it guards is silent: an agent
 * decomposing a ticket into five children files three, gets a refusal it reads
 * as "fine, that's the limit", and reports the decomposition as done. The three
 * that exist and the two that do not look identical on the board afterwards -
 * nothing anywhere records that a decomposition was truncated.
 *
 * So the refusal states the truncation outright, forbids reporting the work as
 * complete, and tells the agent to record the remainder with a count. And it
 * names BOTH rungs of the ceiling chain, because "raise the limit" is
 * unactionable when the operator does not know whether the number came from
 * their project, their env file, or a built-in default.
 */
export function describeTicketCapRefusal(args: {
  max: number;
  source: MaxTicketsSource;
  projectId: string;
}): AgentTicketRefusal {
  const where =
    args.source === "project"
      ? `This project's limit is ${args.max}. Raise it at ${AGENT_TICKET_CAP_LABEL}, on the project ` +
        `page (${agentTicketSettingsPath(args.projectId)}).`
      : args.source === "env"
        ? `The limit is ${args.max}, set instance-wide by DEVPILOT_MAX_TICKETS_PER_RUN. An operator ` +
          `can raise it for THIS project alone at ${AGENT_TICKET_CAP_LABEL}, on the project page ` +
          `(${agentTicketSettingsPath(args.projectId)}), without changing it everywhere.`
        : `The limit is the default of ${args.max}. An operator can raise it for THIS project at ` +
          `${AGENT_TICKET_CAP_LABEL}, on the project page ` +
          `(${agentTicketSettingsPath(args.projectId)}), or instance-wide via ` +
          `DEVPILOT_MAX_TICKETS_PER_RUN.`;

  return {
    code: "ticket-cap",
    reason:
      `You have already filed ${args.max} ticket(s) from this run, which is the per-run limit. ` +
      "THIS TICKET WAS NOT CREATED. " +
      "If you were breaking work into several tickets, that decomposition is now INCOMPLETE - " +
      "the tickets you did not get to do not exist anywhere, and nothing on the board will show " +
      "that they are missing. Do NOT report the work as done or fully filed. " +
      "Instead, put the full title and description of every remaining ticket into a comment on " +
      "your current ticket, say how many were left unfiled, and say that the per-run limit is why. " +
      where,
  };
}

/**
 * Normalize a title for DETERMINISTIC duplicate detection. Not semantic - two
 * differently-worded tickets for the same work still both land, and that is the
 * right trade: a semantic matcher would need an LLM call on a write path an
 * agent controls, and a false positive there silently swallows real work.
 *
 * Lowercase, strip everything that isn't a letter/digit/space, collapse runs of
 * whitespace. So "Fix the retry loop!" and "fix   the RETRY loop" collide;
 * "Fix retry loop" (a different word set) does not.
 */
export function normalizeTicketTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export type DuplicateCandidate = { id: string; title: string };

/**
 * Deterministic dedupe: return the first OPEN ticket in the project whose
 * normalized title matches, or null. The caller supplies the candidate set -
 * see `loadDuplicateCandidates` for which statuses count as open, and why the
 * set is deliberately wider than just `backlog`.
 */
export function findDuplicateTicket(
  title: string,
  candidates: DuplicateCandidate[],
): DuplicateCandidate | null {
  const normalized = normalizeTicketTitle(title);
  if (normalized.length === 0) return null;
  return candidates.find((c) => normalizeTicketTitle(c.title) === normalized) ?? null;
}

/**
 * Length/shape bounds on the agent's UNTRUSTED title + description. Returns the
 * trimmed values on success. Same limits as the human form's zod schema; stated
 * here rather than reusing it because that schema lives in a `"use server"`
 * module and this one must stay importable from a route + a test.
 */
export function validateAgentTicketInput(input: {
  title: unknown;
  description: unknown;
}): { ok: true; title: string; description: string } | { ok: false; refusal: AgentTicketRefusal } {
  if (typeof input.title !== "string") {
    return { ok: false, refusal: { code: "invalid-input", reason: "title required (string)" } };
  }
  const title = input.title.trim();
  if (title.length < AGENT_TITLE_MIN_CHARS) {
    return {
      ok: false,
      refusal: {
        code: "invalid-input",
        reason: `title must be at least ${AGENT_TITLE_MIN_CHARS} characters`,
      },
    };
  }
  if (title.length > AGENT_TITLE_MAX_CHARS) {
    return {
      ok: false,
      refusal: {
        code: "invalid-input",
        reason: `title must be at most ${AGENT_TITLE_MAX_CHARS} characters (got ${title.length})`,
      },
    };
  }

  if (input.description != null && typeof input.description !== "string") {
    return {
      ok: false,
      refusal: { code: "invalid-input", reason: "description must be a string" },
    };
  }
  const description = ((input.description as string | null | undefined) ?? "").trim();
  if (description.length > AGENT_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      refusal: {
        code: "invalid-input",
        reason: `description must be at most ${AGENT_DESCRIPTION_MAX_CHARS} characters (got ${description.length})`,
      },
    };
  }

  return { ok: true, title, description };
}
