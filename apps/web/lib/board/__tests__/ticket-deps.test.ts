// The pure half of agent-declared ticket dependencies.
//
// These are the decisions `POST /api/runners/tools/create-ticket` delegates to,
// so a regression here is a wrong dependency graph rather than a cosmetic bug -
// and a wrong graph is silent, which is the whole reason the feature exists.

import { describe, it, expect } from "vitest";
import {
  AGENT_DEPENDENCY_RELATION_TYPE,
  AGENT_MAX_DEPENDENCIES,
  classifyDependencyRef,
  describeCycleRefusal,
  describeDuplicateAliasRefusal,
  describeUnknownBlockerRefusal,
  describeUnsatisfiableBlockers,
  planTicketDependencies,
  validateAgentAlias,
  validateAgentDependencyInput,
  type BlockingEdge,
} from "@/lib/board/ticket-deps";

const NEW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const B2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// ───────────────────────────────────────────────────────────────────────────
// DIRECTION.
//
// This is the assertion the task description singles out, and for good reason:
// `ticket_dependencies` names its columns `ticket_id` / `blocks_ticket_id`, the
// second of which reads like "the ticket this one blocks" and means the
// opposite. Both orientations write a valid row and neither errors, so an
// inverted write orders every decomposition exactly backwards - strictly worse
// than the empty graph it replaced, because now the board looks like it has a
// plan.
//
// A test that asserted "a row exists with these two ids in it" would pass in
// both orientations and prove nothing. So the rows are fed through a reader that
// implements `fetchBlockerRows`' actual query shape
// (`.select("blocks_ticket_id").eq("ticket_id", X)`) and we assert the
// ASYMMETRY: the new ticket is held back by the blocker, and the blocker is held
// back by nothing.
// ───────────────────────────────────────────────────────────────────────────

/** Exactly what `fetchBlockerRows` does: for ticket X, its blockers are the rows
 *  whose `ticket_id` is X, and the blocker id is in `blocks_ticket_id`. */
function blockersOf(
  rows: ReadonlyArray<{ ticket_id: string; blocks_ticket_id: string }>,
  ticketId: string,
): string[] {
  return rows.filter((r) => r.ticket_id === ticketId).map((r) => r.blocks_ticket_id);
}

describe("planTicketDependencies - edge DIRECTION", () => {
  it("makes the NEW ticket the blocked one and the named ticket the blocker", () => {
    const plan = planTicketDependencies({
      newTicketId: NEW,
      blockers: [{ ticketId: B1, ref: "engine" }],
      existingEdges: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // The asymmetry IS the assertion. Swap the two column names in
    // `planTicketDependencies` and exactly these two lines flip.
    expect(blockersOf(plan.rows, NEW)).toEqual([B1]);
    expect(blockersOf(plan.rows, B1)).toEqual([]);
  });

  it("writes a blocking relation flavour, not an informational one", () => {
    // `related` / `duplicate` rows live in the same table and never gate
    // readiness (BLOCKING_RELATION_TYPES). Writing one of those would produce a
    // graph that renders correctly and schedules nothing.
    const plan = planTicketDependencies({
      newTicketId: NEW,
      blockers: [{ ticketId: B1, ref: "engine" }],
      existingEdges: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rows[0]!.relation_type).toBe(AGENT_DEPENDENCY_RELATION_TYPE);
    expect(["blocked_by", "builds_on"]).toContain(AGENT_DEPENDENCY_RELATION_TYPE);
  });

  it("keeps every blocker in a multi-blocker set, all pointing the same way", () => {
    const plan = planTicketDependencies({
      newTicketId: NEW,
      blockers: [
        { ticketId: B1, ref: "engine" },
        { ticketId: B2, ref: "DevPilot-34" },
      ],
      existingEdges: [],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(blockersOf(plan.rows, NEW).sort()).toEqual([B1, B2].sort());
    expect(blockersOf(plan.rows, B1)).toEqual([]);
    expect(blockersOf(plan.rows, B2)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CYCLES.
//
// On the create path a cycle is not expressible (nothing points at a ticket that
// does not exist yet), so these drive the detector directly. That is the point:
// the guard exists so the property is CHECKED rather than argued, and these are
// what make it fire the day a "link two existing tickets" path is added.
// ───────────────────────────────────────────────────────────────────────────

describe("planTicketDependencies - cycle refusal", () => {
  it("refuses a self edge", () => {
    const plan = planTicketDependencies({
      newTicketId: NEW,
      blockers: [{ ticketId: NEW, ref: "itself" }],
      existingEdges: [],
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal.code).toBe("dependency-cycle");
  });

  it("refuses a direct two-ticket loop", () => {
    // B1 already waits on NEW; making NEW wait on B1 deadlocks both forever.
    const edges: BlockingEdge[] = [{ ticketId: B1, blocksTicketId: NEW }];
    const plan = planTicketDependencies({
      newTicketId: NEW,
      blockers: [{ ticketId: B1, ref: "engine" }],
      existingEdges: edges,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal.code).toBe("dependency-cycle");
    // The refusal has to say the ticket does not exist, or the agent moves on
    // believing it filed something.
    expect(plan.refusal.reason).toMatch(/NOT CREATED/);
    expect(plan.refusal.reason).toContain("engine");
  });

  it("refuses a loop that closes through an intermediate ticket", () => {
    const edges: BlockingEdge[] = [
      { ticketId: B1, blocksTicketId: B2 },
      { ticketId: B2, blocksTicketId: NEW },
    ];
    const plan = planTicketDependencies({
      newTicketId: NEW,
      blockers: [{ ticketId: B1, ref: "DevPilot-34" }],
      existingEdges: edges,
    });
    expect(plan.ok).toBe(false);
  });

  it("allows a diamond - two blockers sharing an ancestor is not a cycle", () => {
    // The naive "have I seen this node" check written the wrong way round
    // reports a false cycle here, which would refuse an entirely ordinary
    // decomposition.
    const shared = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const edges: BlockingEdge[] = [
      { ticketId: B1, blocksTicketId: shared },
      { ticketId: B2, blocksTicketId: shared },
    ];
    const plan = planTicketDependencies({
      newTicketId: NEW,
      blockers: [
        { ticketId: B1, ref: "a" },
        { ticketId: B2, ref: "b" },
      ],
      existingEdges: edges,
    });
    expect(plan.ok).toBe(true);
  });

  it("terminates on a graph that is ALREADY cyclic and does not involve us", () => {
    // A pre-existing loop elsewhere must not hang the walk - a write path an
    // agent controls must not be able to spin the request thread.
    const x = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const y = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const edges: BlockingEdge[] = [
      { ticketId: B1, blocksTicketId: x },
      { ticketId: x, blocksTicketId: y },
      { ticketId: y, blocksTicketId: x },
    ];
    const plan = planTicketDependencies({
      newTicketId: NEW,
      blockers: [{ ticketId: B1, ref: "a" }],
      existingEdges: edges,
    });
    expect(plan.ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Reference forms.
// ───────────────────────────────────────────────────────────────────────────

describe("classifyDependencyRef", () => {
  it("recognises the three forms", () => {
    expect(classifyDependencyRef(B1)).toMatchObject({ kind: "uuid", ticketId: B1 });
    expect(classifyDependencyRef("DevPilot-34")).toMatchObject({ kind: "key", ticketNumber: 34 });
    expect(classifyDependencyRef("engine")).toMatchObject({ kind: "alias", alias: "engine" });
  });

  it("is case- and whitespace-forgiving, since a model wrote it", () => {
    expect(classifyDependencyRef("  devpilot-7 ")).toMatchObject({ kind: "key", ticketNumber: 7 });
    expect(classifyDependencyRef("Engine")).toMatchObject({ kind: "alias", alias: "engine" });
    expect(classifyDependencyRef(B1.toUpperCase())).toMatchObject({ kind: "uuid", ticketId: B1 });
  });

  it("rejects anything that is none of the three", () => {
    for (const junk of ["", "  ", "#34", "34", "DevPilot-", "devpilot-0", "-engine", 7, null, {}]) {
      expect(classifyDependencyRef(junk)).toBeNull();
    }
  });
});

describe("validateAgentAlias", () => {
  it("normalizes to lower case", () => {
    expect(validateAgentAlias("Engine-Core")).toEqual({ ok: true, alias: "engine-core" });
  });

  // This is what removes the resolution-order question from
  // `classifyDependencyRef` entirely. An alias named `devpilot-3` would shadow
  // the ticket the board prints `DevPilot-3` on, and every later reference would
  // silently mean something other than what it says.
  it("refuses an alias shaped like a ticket key or a uuid", () => {
    expect(validateAgentAlias("DevPilot-3").ok).toBe(false);
    expect(validateAgentAlias(B1).ok).toBe(false);
  });

  it("refuses junk, over-long and non-string aliases", () => {
    expect(validateAgentAlias("").ok).toBe(false);
    expect(validateAgentAlias("9lives").ok).toBe(false);
    expect(validateAgentAlias("has space").ok).toBe(false);
    expect(validateAgentAlias("x".repeat(41)).ok).toBe(false);
    expect(validateAgentAlias(42).ok).toBe(false);
  });
});

describe("validateAgentDependencyInput", () => {
  it("is a no-op when neither field is supplied (the backward-compatible path)", () => {
    expect(validateAgentDependencyInput({})).toEqual({
      ok: true,
      value: { alias: null, refs: [] },
    });
    expect(validateAgentDependencyInput({ alias: null, dependsOn: null })).toEqual({
      ok: true,
      value: { alias: null, refs: [] },
    });
  });

  it("de-duplicates repeated references rather than emitting a colliding edge", () => {
    // `ticket_dependencies` is keyed on (ticket_id, blocks_ticket_id), so the
    // second row would fail the whole insert. The two entries mean one edge.
    const res = validateAgentDependencyInput({ dependsOn: ["engine", "Engine", "engine"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.refs).toHaveLength(1);
  });

  it("refuses a ticket that names its own alias", () => {
    const res = validateAgentDependencyInput({ alias: "engine", dependsOn: ["engine"] });
    expect(res.ok).toBe(false);
  });

  it("refuses more blockers than the ceiling, rather than truncating", () => {
    const many = Array.from({ length: AGENT_MAX_DEPENDENCIES + 1 }, (_, i) => `dep${i}`);
    const res = validateAgentDependencyInput({ dependsOn: many });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain(String(AGENT_MAX_DEPENDENCIES));
  });

  it("refuses a non-array dependsOn and an unusable entry", () => {
    expect(validateAgentDependencyInput({ dependsOn: "engine" }).ok).toBe(false);
    expect(validateAgentDependencyInput({ dependsOn: ["engine", "#34"] }).ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refusal COPY. Same rule as `agent-ticket.ts`: the refusal is very often the
// only text about this route an operator ever sees, so a test asserting only the
// `code` would pass against copy that leaves both the agent and the operator
// with nothing to act on.
// ───────────────────────────────────────────────────────────────────────────

describe("refusal copy", () => {
  it("tells the agent nothing was created and lists the aliases it does have", () => {
    const r = describeUnknownBlockerRefusal({
      unresolved: ["engien"],
      aliasesDefinedThisRun: ["engine", "sca-scaffold"],
    });
    expect(r.code).toBe("unknown-blocker");
    expect(r.reason).toMatch(/NOT CREATED/);
    expect(r.reason).toContain("engien");
    expect(r.reason).toContain("engine");
    expect(r.reason).toContain("sca-scaffold");
    // The same-project rule is the security boundary, and an agent that does not
    // know about it reads the refusal as a flake and retries.
    expect(r.reason).toMatch(/same project/i);
  });

  it("handles the no-aliases-yet case without pretending there are some", () => {
    const r = describeUnknownBlockerRefusal({ unresolved: ["engine"], aliasesDefinedThisRun: [] });
    expect(r.reason).toMatch(/not defined any aliases/i);
  });

  it("explains why a duplicate alias is refused rather than merged", () => {
    const r = describeDuplicateAliasRefusal("engine");
    expect(r.code).toBe("duplicate-alias");
    expect(r.reason).toMatch(/NOT CREATED/);
    expect(r.reason).toContain("engine");
  });

  it("explains that a cycle deadlocks BOTH tickets permanently", () => {
    const r = describeCycleRefusal({ blockerRef: "DevPilot-34" });
    expect(r.code).toBe("dependency-cycle");
    expect(r.reason).toMatch(/NOT CREATED/);
    // The permanence is the part that makes this worth refusing rather than
    // warning about: a deadlocked pair never resolves and the board never says so.
    expect(r.reason).toMatch(/forever/i);
    expect(r.reason).toMatch(/could ever become ready/i);
    expect(r.reason).toContain("DevPilot-34");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Satisfiability. Nothing in the codebase checked this at any layer before.
// ───────────────────────────────────────────────────────────────────────────

describe("describeUnsatisfiableBlockers", () => {
  it("says nothing when every blocker can still close", () => {
    expect(
      describeUnsatisfiableBlockers([
        { ref: "DevPilot-1", status: "backlog" },
        { ref: "DevPilot-2", status: "done" },
        { ref: "DevPilot-3", status: "in_progress" },
      ]),
    ).toBeNull();
  });

  it("warns about a failed blocker, which classifyBlocker never counts as closed", () => {
    const msg = describeUnsatisfiableBlockers([
      { ref: "DevPilot-1", status: "backlog" },
      { ref: "DevPilot-9", status: "failed" },
    ]);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("DevPilot-9");
    expect(msg!).not.toContain("DevPilot-1");
    // It is a warning on a SUCCESSFUL create, not a refusal - the operator may
    // well retry the failed ticket, and refusing would push the agent to drop a
    // real dependency to get its ticket filed.
    expect(msg!).toMatch(/was created/i);
  });
});
