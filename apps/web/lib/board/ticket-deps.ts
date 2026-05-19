// Agent-declared ticket dependencies - the PURE half.
//
// WHY THIS EXISTS
// ───────────────
// `devpilot_create_ticket` took no dependency argument, so an agent decomposing a
// ticket into children had exactly one way to express ordering: prose. On
// 2026-08-02 four separate decompositions on one board did precisely that -
// descriptions saying "depends on child ticket X being landed - do not start
// before that engine ticket is done" - and the graph stayed empty, so the drain
// dispatched every child at once. Three burned a run each re-deriving "my
// dependency is missing"; one produced a two-writer collision on a shared
// workspace; one ticket re-blocked itself on every re-dispatch, correctly and
// forever. The agents were not at fault: the intent was present every time, in
// the only place the tool let them put it, and the scheduler cannot read prose.
//
// So this module is the decision core for a `dependsOn` argument. It is pure so
// that every refusal is unit-testable in isolation; the IO (resolving a
// reference to a row, loading the edge closure, writing the rows) lives in
// `ticket-deps.server.ts`.
//
// THE FORWARD-REFERENCE PROBLEM, AND HOW IT IS SOLVED
// ──────────────────────────────────────────────────
// A decomposition files N children in one run and child 2 usually depends on
// child 1, whose uuid does not exist until child 1 is created. A design that
// cannot express that fails the exact case that motivated the work.
//
// The solution is a RUN-LOCAL ALIAS. The agent labels a ticket as it files it
// (`alias: "engine"`) and later calls reference that label
// (`dependsOn: ["engine"]`). The alias is stored on the created row
// (`tickets.agent_alias`, scoped by `source_run_id`), so it is durable across
// the separate HTTP requests each tool call makes, and it is written in the SAME
// insert as the ticket - there is no window in which a ticket exists without its
// label.
//
// A `dependsOn` entry is resolved as ONE of three unambiguous forms:
//
//   • a run-local alias         `"engine"`      - a sibling filed by THIS run
//   • a ticket key              `"DevPilot-34"`  - any ticket in the same project
//   • a ticket uuid             `"1111…"`       - likewise
//
// The three forms cannot collide, because `validateAgentAlias` REFUSES an alias
// that is shaped like a key or a uuid. That is what removes the resolution-order
// question entirely rather than answering it with a precedence rule nobody would
// remember.
//
// Both of the other two forms matter, and neither is a nice-to-have: the
// incident needed sibling-to-sibling edges (the six SCA tickets pointing at the
// one that builds the shared scaffold) AND child-to-pre-existing edges (#27
// gated on Step 4, a ticket that already existed).
//
// ALIASES RESOLVE BACKWARDS ONLY, DELIBERATELY
// ────────────────────────────────────────────
// An alias names a ticket that has already been created in this run. There is no
// deferred/forward resolution, and adding one would be actively harmful: a
// pending edge whose alias is never defined (the agent hits the per-run cap, or
// simply stops) is either silently dropped - which is the bug this fixes,
// wearing a new hat - or left as a promise nothing can satisfy, i.e. a ticket
// wedged against a blocker that will never exist. So an unresolvable reference
// is a hard refusal, and the agent files in dependency order.
//
// WHY `blocked_by` AND NOT `builds_on`
// ────────────────────────────────────
// Both are in `BLOCKING_RELATION_TYPES`, so both gate readiness identically.
// `builds_on` additionally re-roots the child's workspace on the parent's branch
// or landed sha, and `loadBuildsOnBase` expects at most one parent (it warns and
// picks the first when there are several). `dependsOn` is a SET, so the only
// relation that models it faithfully is `blocked_by`. With auto-land on, the
// readiness gate already holds a dependent until the blocker's work is on the
// integration branch, so a `blocked_by` child starts from a tree that provably
// contains its blocker's commits - which is what the incident actually needed.

/** Blocking flavour written for every agent-declared dependency. See the header:
 *  `builds_on` is single-parent-shaped and re-roots a workspace; `dependsOn` is
 *  a set and only needs ordering. Both gate readiness the same way. */
export const AGENT_DEPENDENCY_RELATION_TYPE = "blocked_by" as const;

/**
 * How many blockers ONE agent-filed ticket may declare (CLAUDE.md §3 - hard
 * ceilings everywhere). A ticket with more than ten blockers is a modelling
 * mistake rather than a plan, and each entry costs a lookup on a write path an
 * agent controls. Refused, never truncated: a silently dropped blocker is the
 * exact failure this feature exists to end.
 */
export const AGENT_MAX_DEPENDENCIES = 10;

export const AGENT_ALIAS_MAX_CHARS = 40;

/** A run-local label. Lower-cased before matching, so the agent may write
 *  `Engine` and reference `engine`. Must start with a letter so it can never be
 *  confused with a bare ticket number. */
const ALIAS_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** `DevPilot-34` - the key the board prints on every card (`formatTicketKey`).
 *  Matched case-insensitively via the lower-cased form. */
const TICKET_KEY_RE = /^devpilot-(\d{1,9})$/;

/** Anything starting `devpilot-` is RESERVED, whether or not it parses as a key.
 *  `devpilot-` and `devpilot-x` are otherwise legal alias shapes, so without this
 *  a mistyped ticket key would be silently reinterpreted as a label - and the
 *  agent would be told "no such alias" about something it wrote as a key. Both
 *  the alias validator and the reference classifier consult it, so the reserved
 *  space is the same on the writing and the reading side. */
const RESERVED_PREFIX_RE = /^devpilot-/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DependencyRef =
  | { kind: "alias"; raw: string; alias: string }
  | { kind: "key"; raw: string; ticketNumber: number }
  | { kind: "uuid"; raw: string; ticketId: string };

/** Stable identity for a ref, used to key the resolution map. */
export function dependencyRefKey(ref: DependencyRef): string {
  return ref.kind === "alias"
    ? `alias:${ref.alias}`
    : ref.kind === "key"
      ? `key:${ref.ticketNumber}`
      : `uuid:${ref.ticketId}`;
}

/**
 * Classify ONE `dependsOn` entry into exactly one of the three reference forms,
 * or null when it is none of them.
 *
 * The forms are mutually exclusive BY CONSTRUCTION (an alias may not be shaped
 * like a key or a uuid - see `validateAgentAlias`), so this never has to pick a
 * winner and there is no precedence rule to get wrong.
 */
export function classifyDependencyRef(raw: unknown): DependencyRef | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();

  if (UUID_RE.test(lower)) return { kind: "uuid", raw: trimmed, ticketId: lower };

  const key = TICKET_KEY_RE.exec(lower);
  if (key) {
    const n = Number(key[1]);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return { kind: "key", raw: trimmed, ticketNumber: n };
  }

  // A near-miss ticket key (`DevPilot-`, `devpilot-12a`) is a typo, not a label.
  // Falling through to the alias branch would answer it with "no such alias",
  // which sends the agent looking for a bug in its own decomposition.
  if (RESERVED_PREFIX_RE.test(lower)) return null;

  if (ALIAS_RE.test(lower)) return { kind: "alias", raw: trimmed, alias: lower };

  return null;
}

// ---------------------------------------------------------------------------
// Refusals.
//
// Same discipline as `agent-ticket.ts`: a refusal reaches the agent as a
// tool_result and is very often the only text about this route an operator ever
// sees (the agent quotes it into a `devpilot_request_human` escalation). So every
// refusal here says what was refused, why, and what to do instead - and above
// all it says THE TICKET WAS NOT CREATED, because a dependency refusal that
// reads as a warning would leave the agent believing the ticket exists.
// ---------------------------------------------------------------------------

export type TicketDepRefusalCode =
  /** A `dependsOn` entry did not resolve to a ticket in this project. Covers
   *  "no such ticket", "another project" and "another tenant" with ONE code, on
   *  purpose: distinguishing them would confirm the existence of rows outside
   *  the agent's project, and the remedy is identical in all three cases. */
  | "unknown-blocker"
  /** The alias is already in use by another ticket this run filed. */
  | "duplicate-alias"
  /** The edge would close a loop, deadlocking both tickets forever. */
  | "dependency-cycle";

export type TicketDepRefusal = { code: TicketDepRefusalCode; reason: string };

export function describeUnknownBlockerRefusal(args: {
  /** The raw strings, exactly as the agent wrote them. */
  unresolved: readonly string[];
  /** Aliases this run has already defined - a small closed set, which is what
   *  makes this refusal actionable in a way a bare "not found" is not. */
  aliasesDefinedThisRun: readonly string[];
}): TicketDepRefusal {
  const listed = args.unresolved.map((r) => `"${r}"`).join(", ");
  const known =
    args.aliasesDefinedThisRun.length > 0
      ? `Aliases you have defined on this run so far: ${args.aliasesDefinedThisRun
          .map((a) => `"${a}"`)
          .join(", ")}.`
      : "You have not defined any aliases on this run yet.";
  return {
    code: "unknown-blocker",
    reason:
      `THIS TICKET WAS NOT CREATED. These dependsOn entries did not resolve to a ticket in ` +
      `this project: ${listed}. ` +
      "A dependsOn entry must be one of: an alias you gave an EARLIER devpilot_create_ticket " +
      "call on this same run; a ticket key like DevPilot-34; or a ticket uuid. It must name a " +
      "ticket in the SAME project you are working in - a ticket in another project or another " +
      `workspace is refused, not silently ignored. ${known} ` +
      "Aliases only ever point BACKWARDS, so file a blocker BEFORE the tickets that depend on " +
      "it. Fix the reference and call again; nothing was created, so this is not a duplicate.",
  };
}

export function describeDuplicateAliasRefusal(alias: string): TicketDepRefusal {
  return {
    code: "duplicate-alias",
    reason:
      `THIS TICKET WAS NOT CREATED. You already used the alias "${alias}" for a different ticket ` +
      "on this run. Re-using it would silently repoint every dependsOn entry that names it, so " +
      "it is refused. Pick a different alias and call again.",
  };
}

export function describeCycleRefusal(args: { blockerRef: string }): TicketDepRefusal {
  return {
    code: "dependency-cycle",
    reason:
      `THIS TICKET WAS NOT CREATED. Depending on ${args.blockerRef} would close a dependency ` +
      "loop: that ticket already depends, directly or through other tickets, on the one you are " +
      "creating. Neither ticket could ever become ready - each would wait for the other forever, " +
      "with nothing on the board explaining why. Drop that entry, or break the existing chain " +
      "first, and call again.",
  };
}

// ---------------------------------------------------------------------------
// Input validation.
// ---------------------------------------------------------------------------

export type ValidatedDependencyInput = {
  /** Normalized (lower-cased) alias for the ticket being created, or null. */
  alias: string | null;
  /** De-duplicated, order-preserving list of parsed blocker references. */
  refs: DependencyRef[];
};

export type DependencyInputResult =
  | { ok: true; value: ValidatedDependencyInput }
  | { ok: false; reason: string };

/**
 * Shape-check the two new UNTRUSTED fields.
 *
 * Returns a plain `reason` rather than a `TicketDepRefusal` because these are
 * malformed-input failures, and the route reports them under the existing
 * `invalid-input` code alongside the title/description bounds - one code for
 * "your arguments are the wrong shape", distinct from the three codes that mean
 * "your arguments were well-formed and I still will not do this".
 */
export function validateAgentDependencyInput(input: {
  alias?: unknown;
  dependsOn?: unknown;
}): DependencyInputResult {
  let alias: string | null = null;
  if (input.alias !== undefined && input.alias !== null && input.alias !== "") {
    const parsed = validateAgentAlias(input.alias);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    alias = parsed.alias;
  }

  const rawDeps = input.dependsOn;
  if (rawDeps === undefined || rawDeps === null) return { ok: true, value: { alias, refs: [] } };
  if (!Array.isArray(rawDeps)) {
    return { ok: false, reason: "dependsOn must be an array of ticket references" };
  }
  if (rawDeps.length > AGENT_MAX_DEPENDENCIES) {
    return {
      ok: false,
      reason:
        `dependsOn may name at most ${AGENT_MAX_DEPENDENCIES} blockers (got ${rawDeps.length}). ` +
        "A ticket with more blockers than that is usually two tickets.",
    };
  }

  const refs: DependencyRef[] = [];
  const seen = new Set<string>();
  for (const raw of rawDeps) {
    const ref = classifyDependencyRef(raw);
    if (!ref) {
      return {
        ok: false,
        reason:
          `dependsOn entry ${JSON.stringify(raw)} is not a usable ticket reference. Use an alias ` +
          "you gave an earlier ticket on this run (letters, digits, - and _, starting with a " +
          "letter), a ticket key like DevPilot-34, or a ticket uuid.",
      };
    }
    const key = dependencyRefKey(ref);
    // A repeated reference is the same edge twice, and `ticket_dependencies` is
    // keyed on (ticket_id, blocks_ticket_id) so the second insert would collide
    // and fail the whole batch. De-duplicating is not leniency about a bad
    // argument - the two entries mean exactly one thing.
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }

  // An alias may not name the ticket that is declaring it: the ticket does not
  // exist yet, so this can only be a mistake, and letting it through would look
  // to the agent like a self-blocking ticket rather than a typo.
  if (alias && refs.some((r) => r.kind === "alias" && r.alias === alias)) {
    return {
      ok: false,
      reason: `dependsOn names this ticket's own alias "${alias}"; a ticket cannot block itself.`,
    };
  }

  return { ok: true, value: { alias, refs } };
}

export type AliasResult = { ok: true; alias: string } | { ok: false; reason: string };

/**
 * Validate the alias the agent is assigning to the ticket it is creating.
 *
 * The key-shaped and uuid-shaped refusals are the load-bearing ones. They are
 * what let `classifyDependencyRef` decide a reference's form with no precedence
 * rule: without them an agent could name a ticket `devpilot-3` and every later
 * `dependsOn: ["DevPilot-3"]` would silently mean something other than the ticket
 * the board prints that key on.
 */
export function validateAgentAlias(raw: unknown): AliasResult {
  if (typeof raw !== "string") return { ok: false, reason: "alias must be a string" };
  const alias = raw.trim().toLowerCase();
  if (alias.length === 0) return { ok: false, reason: "alias must not be empty" };
  if (alias.length > AGENT_ALIAS_MAX_CHARS) {
    return {
      ok: false,
      reason: `alias must be at most ${AGENT_ALIAS_MAX_CHARS} characters (got ${alias.length})`,
    };
  }
  if (UUID_RE.test(alias) || RESERVED_PREFIX_RE.test(alias)) {
    return {
      ok: false,
      reason:
        `alias ${JSON.stringify(raw)} looks like a ticket reference. An alias is your own ` +
        'short label for a ticket you are filing now (e.g. "engine", "sca-scaffold"); it ' +
        'must not be a uuid or start with "devpilot-", or later references would be ambiguous.',
    };
  }
  if (!ALIAS_RE.test(alias)) {
    return {
      ok: false,
      reason:
        `alias ${JSON.stringify(raw)} is not usable. Start with a letter and use only letters, ` +
        "digits, - and _.",
    };
  }
  return { ok: true, alias };
}

// ---------------------------------------------------------------------------
// Edge planning - the DIRECTION seam and the cycle guard.
// ---------------------------------------------------------------------------

/**
 * One row of `ticket_dependencies`, in the table's own vocabulary.
 *
 * THE DIRECTION IS THE PART THAT IS EASY TO GET BACKWARDS, and getting it
 * backwards is silent: both orientations write a perfectly valid row, and the
 * board renders something plausible either way. For ticket X, X's blockers are
 * the rows with `ticket_id = X`, and the blocker's id sits in the
 * misleadingly-named `blocks_ticket_id` (read `fetchBlockerRows` in
 * `dependencies.ts`: `.select("blocks_ticket_id").eq("ticket_id", ticketId)`).
 * So "C is blocked by B" is `{ ticket_id: C, blocks_ticket_id: B }`.
 *
 * Inverting it would not fail anywhere - it would order every decomposition
 * exactly backwards, which is worse than the empty graph it replaced. This is
 * the ONE function that writes the orientation, so `planTicketDependencies` is
 * the one place a test has to pin.
 */
export type TicketDependencyRow = {
  ticket_id: string;
  blocks_ticket_id: string;
  relation_type: typeof AGENT_DEPENDENCY_RELATION_TYPE;
};

/** An existing blocking edge: `ticketId` is held back by `blocksTicketId`. */
export type BlockingEdge = { ticketId: string; blocksTicketId: string };

export type DependencyPlan =
  | { ok: true; rows: TicketDependencyRow[] }
  | { ok: false; refusal: TicketDepRefusal };

/**
 * Turn a resolved blocker set into the rows to insert, refusing anything that
 * would deadlock.
 *
 * ON THE CYCLE CHECK, HONESTLY. This route only ever creates a BRAND-NEW ticket,
 * and every reference is resolved against tickets that ALREADY EXIST, so at the
 * moment these edges are computed nothing in the graph points at the new node
 * and a cycle is not expressible. The check is therefore defence in depth today
 * - but the property it protects rests on two things that a future change could
 * quietly drop (create-only, and resolve-before-exists), and a deadlocked pair
 * is permanent and invisible: neither ticket can ever become ready and nothing
 * on the board says why. So it is CHECKED rather than argued, at the one seam
 * that computes edges, and it is the guard that fires the day someone adds a
 * "link two existing tickets" path.
 *
 * `newTicketId` is real, not a placeholder: the route pre-generates the id so
 * this whole plan runs BEFORE the insert. That is what makes every refusal here
 * leave nothing behind.
 */
export function planTicketDependencies(args: {
  newTicketId: string;
  /** Resolved blocker ticket ids, paired with the agent's own wording so a
   *  refusal can quote what the agent actually wrote. */
  blockers: ReadonlyArray<{ ticketId: string; ref: string }>;
  /** Every blocking edge reachable from the blockers (`loadBlockingEdgeClosure`). */
  existingEdges: readonly BlockingEdge[];
}): DependencyPlan {
  const { newTicketId, blockers, existingEdges } = args;

  // Adjacency in the "is blocked by" direction: from a ticket to the tickets
  // holding it back. Walking it from a proposed blocker asks exactly the right
  // question - "does this ticket already wait, directly or transitively, on the
  // ticket I am about to make it block?".
  const blockedBy = new Map<string, string[]>();
  for (const e of existingEdges) {
    const list = blockedBy.get(e.ticketId);
    if (list) list.push(e.blocksTicketId);
    else blockedBy.set(e.ticketId, [e.blocksTicketId]);
  }

  const rows: TicketDependencyRow[] = [];
  for (const b of blockers) {
    if (b.ticketId === newTicketId) {
      return { ok: false, refusal: describeCycleRefusal({ blockerRef: b.ref }) };
    }
    if (reaches(blockedBy, b.ticketId, newTicketId)) {
      return { ok: false, refusal: describeCycleRefusal({ blockerRef: b.ref }) };
    }
    rows.push({
      // DIRECTION: the new ticket is the one being held back, so it is
      // `ticket_id`; the blocker goes in `blocks_ticket_id`. See the type's doc.
      ticket_id: newTicketId,
      blocks_ticket_id: b.ticketId,
      relation_type: AGENT_DEPENDENCY_RELATION_TYPE,
    });
  }
  return { ok: true, rows };
}

/** Breadth-first reachability, cycle-safe (a pre-existing loop in the stored
 *  graph must make this terminate, not hang). */
function reaches(adj: Map<string, string[]>, from: string, target: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of adj.get(node) ?? []) {
      if (next === target) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Satisfiability - reported, never refused.
// ---------------------------------------------------------------------------

/**
 * A blocker in a state that will never close on its own.
 *
 * `classifyBlocker` (lib/integration/landed.ts) reads any status other than
 * `done` as `working`, i.e. OPEN - and that includes `failed`. So a ticket
 * blocked by a failed ticket can never reach `ready`, and nothing anywhere says
 * so: the dependent simply sits in the backlog forever. Nothing in the codebase
 * checked this before, at any layer, for any caller.
 *
 * This is reported as a WARNING on an otherwise successful create, not a
 * refusal. A failed blocker is a legitimate thing to depend on - the operator
 * may well retry or reopen it, and refusing would make the agent drop a real
 * dependency to get its ticket filed, which is the behaviour that caused the
 * incident. Saying it out loud at the moment the edge is written is the part
 * that was missing.
 */
export function describeUnsatisfiableBlockers(
  blockers: ReadonlyArray<{ ref: string; status: string }>,
): string | null {
  const dead = blockers.filter((b) => b.status === "failed");
  if (dead.length === 0) return null;
  const listed = dead.map((b) => b.ref).join(", ");
  return (
    `The ticket was created, but ${dead.length === 1 ? "a blocker it names is" : "blockers it names are"} ` +
    `in the "failed" state (${listed}). A failed blocker never counts as satisfied, so this ticket ` +
    "cannot become ready until someone reopens or retries it. Say so in a comment rather than " +
    "assuming it will start on its own."
  );
}
