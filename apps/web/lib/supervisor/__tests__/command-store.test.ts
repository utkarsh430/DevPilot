// Running an operator command.
//
// What these assert, in rough order of how much they matter:
//
//  1. THE TARGET IS RE-DERIVED SERVER-SIDE from the operator's message. A
//     command id is not enough on its own: sending a valid id with a message
//     that does not name the ticket is refused, so a forged POST cannot reach a
//     ticket the operator never wrote down.
//  2. EVERY COMMAND ROUTES TO AN INJECTED PRIMITIVE. The deps are spies, so a
//     reimplementation shows up as a primitive that was never called.
//  3. A LEDGER ROW IS WRITTEN, with the non-defect cause, on every commanded
//     change - and NOT written when nothing changed.
//  4. A PRIMITIVE'S REFUSAL IS REPORTED, not worked around, and leaves the
//     board alone.
//
// The Supabase fake ACTUALLY APPLIES `.eq` / `.in` / `.is`, for the reason
// `console-store.test.ts` gives at length: a fake that ignores filters makes
// every scoping assertion vacuous.

import { describe, expect, it, vi } from "vitest";
import {
  loadOperatorCommands,
  runConsoleCommand,
  type CommandDeps,
} from "@/lib/supervisor/command-store";
import { CONFIRM_ACK_TOKEN } from "@/lib/supervisor/console-commands";
import type { DispatchQueueGroup } from "@/lib/engine/dispatch-rescue-policy";

const OURS = "tenant-ours";
const PROJECT = "proj-1";
const NOW = "2026-08-04T12:00:00.000Z";

type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>) {
  const inserted: Array<{ table: string; row: Row }> = [];
  const db = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder = {
        select: () => builder,
        insert(row: Row) {
          inserted.push({ table, row });
          return {
            ...builder,
            then: (r: (v: unknown) => unknown) => Promise.resolve(r({ error: null })),
          };
        },
        eq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        neq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] !== val);
          return builder;
        },
        is(col: string, val: unknown) {
          rows = rows.filter((r) =>
            val === null ? r[col] === null || r[col] === undefined : r[col] === val,
          );
          return builder;
        },
        or: () => builder,
        in(col: string, vals: unknown[]) {
          rows = rows.filter((r) => vals.includes(r[col]));
          return builder;
        },
        lt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: rows, error: null })),
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, inserted };
}

function baseTables(over: { supervisorEnabled?: boolean; ticket?: Row } = {}) {
  return {
    projects: [
      {
        id: PROJECT,
        tenant_id: OURS,
        name: "scoursh",
        supervisor_enabled: over.supervisorEnabled ?? true,
        automation_state: "running",
      },
    ],
    tenants: [{ id: OURS, automation_state: "running" }],
    engine_liveness: [{ id: "recovery-cron", last_seen_at: NOW }],
    tickets: [
      {
        id: "t-27",
        tenant_id: OURS,
        project_id: PROJECT,
        ticket_number: 27,
        title: "add rate limiting",
        status: "in_progress",
        requested_role: "engineer",
        updated_at: NOW,
        landed_sha: null,
        retry_count: 0,
        gate_retry_count: 0,
        safety_critical: false,
        ...(over.ticket ?? {}),
      },
    ],
    runs: [] as Row[],
    comments: [] as Row[],
    ticket_dependencies: [] as Row[],
    dispatch_queue: [] as Row[],
    pending_pushes: [] as Row[],
    integration_queue: [] as Row[],
    supervisor_actions: [] as Row[],
  };
}

function makeDeps(db: unknown, over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    nowIso: NOW,
    loadQueueGroups: async () => [] as DispatchQueueGroup[],
    isAutomationPaused: async () => false,
    releaseQueue: async () => ({ reason: "unused", released: 0 }),
    recoverTicket: async () => ({ ok: true, recovered: false, reason: "unused" }),
    staleSeconds: 300,
    dispatchGraceSeconds: 600,
    orphanGraceSeconds: 1800,

    loadDispatchableRoles: async () => ["engineer", "qa", "security", "tech_lead"],
    countActiveRuns: async () => 0,
    emitDispatch: async () => ({ ok: true }),
    transition: async () => ({ transitioned: true }),
    comment: async () => {},
    pauseTicket: async () => ({ ok: true, paused: true, cancelledRuns: 1 }),
    resumeTicket: async () => ({ ok: true }),
    createTicket: async () => ({ ok: true, ticketId: "t-new", ticketNumber: 99 }),
    resolveDependencyRefs: async () => ({ blockers: [], unresolved: [] }),
    loadBlockingEdges: async () => [],
    insertDependencies: async () => ({ ok: true }),
    armCohortPlan: async () => ({ ok: true }),
    startGoalRun: async () => ({ ok: true, runId: "run-abcdef01-0000-0000-0000-000000000000" }),
    ...over,
  };
}

async function idFor(deps: CommandDeps, question: string, kind: string): Promise<string> {
  const res = await loadOperatorCommands(deps, { tenantId: OURS, projectId: PROJECT, question });
  if (!res.ok) throw new Error(res.error);
  const hit = res.commands.find((c) => c.kind === kind);
  if (!hit) throw new Error(`no ${kind} offered for ${JSON.stringify(question)}`);
  return hit.id;
}

const run = (deps: CommandDeps, over: Partial<Parameters<typeof runConsoleCommand>[1]>) =>
  runConsoleCommand(deps, {
    tenantId: OURS,
    projectId: PROJECT,
    question: "DevPilot-27 please",
    commandId: "",
    payload: {},
    confirmation: CONFIRM_ACK_TOKEN,
    requestedBy: "operator u-1",
    requestedByUserId: "abhi@example.com",
    ...over,
  });

// ═══════════════════════════════════════════════════════════════════════════
// THE TARGET IS RE-DERIVED, SERVER-SIDE, FROM THE OPERATOR'S MESSAGE
// ═══════════════════════════════════════════════════════════════════════════

describe("a command cannot reach a ticket the message does not name", () => {
  it("refuses a VALID id when the accompanying message names no ticket", async () => {
    const { db } = makeDb(baseTables());
    const deps = makeDeps(db, { emitDispatch: vi.fn(async () => ({ ok: true as const })) });
    const id = await idFor(deps, "DevPilot-27 please", "dispatch_ticket");

    const res = await run(deps, {
      commandId: id,
      question: "just tell me what is going on", // no key
      payload: { role: "engineer" },
      confirmation: "",
    });
    expect(res.ok).toBe(false);
    expect(deps.emitDispatch).not.toHaveBeenCalled();
  });

  it("CONTROL: the same id with the message that named the ticket runs", async () => {
    const { db } = makeDb(baseTables());
    const emit = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(db, { emitDispatch: emit });
    const id = await idFor(deps, "DevPilot-27 please", "dispatch_ticket");

    const res = await run(deps, {
      commandId: id,
      question: "DevPilot-27 please",
      payload: { role: "engineer" },
      confirmation: "",
    });
    expect(res.ok).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "t-27", forceRole: "engineer" }),
    );
  });

  it("a hand-built id for a ticket on the board but NOT named is refused", async () => {
    // The id form is deterministic and guessable, deliberately: what makes it
    // safe is not obscurity but that it is looked up against a list derived
    // from the operator's message. Here the ticket exists, the id is exactly
    // the one the console would mint for it, and the message names a different
    // one - so it matches nothing.
    const tables = baseTables();
    tables.tickets.push({
      ...tables.tickets[0]!,
      id: "t-99",
      ticket_number: 99,
      title: "another ticket",
    });
    const emit = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(makeDb(tables).db, { emitDispatch: emit });

    const res = await run(deps, {
      question: "DevPilot-27 please",
      commandId: "cmd:dispatch_ticket:t-99",
      payload: { role: "engineer" },
      confirmation: "",
    });
    expect(res.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();

    // CONTROL: naming 99 instead makes the SAME id resolve.
    const ok = await run(deps, {
      question: "DevPilot-99 please",
      commandId: "cmd:dispatch_ticket:t-99",
      payload: { role: "engineer" },
      confirmation: "",
    });
    expect(ok.ok).toBe(true);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ ticketId: "t-99" }));
  });

  it("a malformed id is refused with nothing attempted", async () => {
    const emit = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(makeDb(baseTables()).db, { emitDispatch: emit });
    const res = await run(deps, { commandId: "cmd:dispatch_ticket:does-not-exist" });
    expect(res.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Gates
// ═══════════════════════════════════════════════════════════════════════════

describe("gates", () => {
  it("ACT is gated on supervisor_enabled", async () => {
    const enabled = makeDeps(makeDb(baseTables()).db);
    const id = await idFor(enabled, "DevPilot-27", "dispatch_ticket");

    const emit = vi.fn(async () => ({ ok: true as const }));
    const off = makeDeps(makeDb(baseTables({ supervisorEnabled: false })).db, {
      emitDispatch: emit,
    });
    const res = await runConsoleCommand(off, {
      tenantId: OURS,
      projectId: PROJECT,
      question: "DevPilot-27",
      commandId: id,
      payload: { role: "engineer" },
      confirmation: "",
      requestedBy: "operator u-1",
      requestedByUserId: "u-1",
    });
    expect(res.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a WEDGED engine does NOT block a commanded action", async () => {
    // Deliberate, and the opposite of the autonomous loop's gate: a human is
    // asking, now, and refusing because a cron might eventually get to it is
    // what teaches people to go to the database by hand.
    const tables = baseTables();
    tables.engine_liveness = [{ id: "recovery-cron", last_seen_at: "2020-01-01T00:00:00.000Z" }];
    const emit = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(makeDb(tables).db, { emitDispatch: emit });
    const id = await idFor(deps, "DevPilot-27", "dispatch_ticket");
    const res = await run(deps, { commandId: id, payload: { role: "qa" }, confirmation: "" });
    expect(res.ok).toBe(true);
    expect(emit).toHaveBeenCalled();
  });

  it("an irreversible command is refused without its typed confirmation", async () => {
    const { db, inserted } = makeDb(baseTables());
    const transition = vi.fn(async () => ({ transitioned: true }));
    const deps = makeDeps(db, { transition });
    const id = await idFor(deps, "DevPilot-27", "close_obsolete");

    const res = await run(deps, {
      commandId: id,
      payload: { reason: "superseded" },
      confirmation: CONFIRM_ACK_TOKEN, // an acknowledgement is NOT enough here
    });
    expect(res.ok).toBe(false);
    expect(transition).not.toHaveBeenCalled();
    // Nothing was written - not the reason comment, not a ledger row.
    expect(inserted).toEqual([]);
  });

  it("CONTROL: with the ticket key typed, it closes", async () => {
    const { db } = makeDb(baseTables());
    const transition = vi.fn(async () => ({ transitioned: true }));
    const deps = makeDeps(db, { transition });
    const id = await idFor(deps, "DevPilot-27", "close_obsolete");
    const res = await run(deps, {
      commandId: id,
      payload: { reason: "superseded" },
      confirmation: "DevPilot-27",
    });
    expect(res.ok).toBe(true);
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ to: "failed" }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Every command routes to a primitive
// ═══════════════════════════════════════════════════════════════════════════

describe("commands route to the injected primitives, never a reimplementation", () => {
  it("pause calls pauseTicket", async () => {
    const pause = vi.fn(async () => ({ ok: true as const, paused: true, cancelledRuns: 2 }));
    const deps = makeDeps(makeDb(baseTables()).db, { pauseTicket: pause });
    const id = await idFor(deps, "DevPilot-27", "pause_ticket");
    const res = await run(deps, { commandId: id });
    expect(res.ok).toBe(true);
    expect(pause).toHaveBeenCalledWith(expect.objectContaining({ ticketId: "t-27" }));
  });

  it("re-scope posts a HUMAN comment, and resumes an input_required ticket", async () => {
    const comment = vi.fn(async () => {});
    const transition = vi.fn(async () => ({ transitioned: true }));
    const deps = makeDeps(makeDb(baseTables({ ticket: { status: "input_required" } })).db, {
      comment,
      transition,
    });
    const id = await idFor(deps, "DevPilot-27", "rescope_ticket");
    const res = await run(deps, { commandId: id, payload: { directive: "narrow it to the API" } });
    expect(res.ok).toBe(true);
    expect(comment).toHaveBeenCalledWith(
      expect.objectContaining({ authorType: "human", body: "narrow it to the API" }),
    );
    // The documented resume path. A directive on a ticket parked on a question
    // that did not resume it would be read by nothing.
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ to: "in_progress", expectedFrom: "input_required" }),
    );
  });

  it("re-scope on a NON-parked ticket does NOT transition it", async () => {
    const transition = vi.fn(async () => ({ transitioned: true }));
    const deps = makeDeps(makeDb(baseTables()).db, { transition });
    const id = await idFor(deps, "DevPilot-27", "rescope_ticket");
    await run(deps, { commandId: id, payload: { directive: "narrow it" } });
    expect(transition).not.toHaveBeenCalled();
  });

  it("create routes to createTicketCore", async () => {
    const create = vi.fn(async () => ({
      ok: true as const,
      ticketId: "t-new",
      ticketNumber: 99,
    }));
    const deps = makeDeps(makeDb(baseTables()).db, { createTicket: create });
    const id = await idFor(deps, "file one", "create_ticket");
    const res = await run(deps, {
      commandId: id,
      question: "file one",
      payload: { title: "rate limit the API", description: "", role: "" },
    });
    expect(res.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "rate limit the API", requestedRole: null }),
    );
  });

  it("a team arms the dispatcher's own cohort plan and then asks it to dispatch", async () => {
    const armed: Array<{ plan: { cohorts: Array<Record<string, unknown>> } }> = [];
    const arm = vi.fn(async (a: { plan: { cohorts: Array<Record<string, unknown>> } }) => {
      armed.push(a);
      return { ok: true as const };
    });
    const emit = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(makeDb(baseTables({ ticket: { status: "ready" } })).db, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      armCohortPlan: arm as any,
      emitDispatch: emit,
    });
    const id = await idFor(deps, "DevPilot-27", "spawn_team");
    const res = await run(deps, {
      commandId: id,
      payload: { roles: ["engineer", "security"], strategy: "all" },
    });
    expect(res.ok).toBe(true);
    expect(armed).toHaveLength(1);
    const plan = armed[0]!;
    expect(plan.plan.cohorts[0]!.members).toEqual(["engineer", "security"]);
    // The dispatch's forceRole MUST equal the cohort's trigger_role or the plan
    // is written and never fires.
    expect(plan.plan.cohorts[0]!.trigger_role).toBe("engineer");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ forceRole: "engineer" }));
  });

  it("an over-cap team is refused BEFORE the plan is armed", async () => {
    const arm = vi.fn(async () => ({ ok: true as const }));
    const emit = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(makeDb(baseTables({ ticket: { status: "ready" } })).db, {
      armCohortPlan: arm,
      emitDispatch: emit,
    });
    const id = await idFor(deps, "DevPilot-27", "spawn_team");
    const res = await run(deps, {
      commandId: id,
      // Five, against a cohort cap of four. Refused by the payload validator
      // against the command's own `max`, which is the engine's constant.
      payload: {
        roles: ["engineer", "security", "qa", "tech_lead", "engineer"],
        strategy: "all",
      },
    });
    expect(res.ok).toBe(false);
    expect(arm).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("dependencies go through the cycle guard, and a cycle is refused", async () => {
    const insert = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(makeDb(baseTables()).db, {
      resolveDependencyRefs: async () => ({
        blockers: [{ ref: "DevPilot-12", ticketId: "t-12", status: "in_progress" }],
        unresolved: [],
      }),
      // t-12 already waits on t-27, so making t-27 wait on t-12 deadlocks both.
      loadBlockingEdges: async () => [{ ticketId: "t-12", blocksTicketId: "t-27" }],
      insertDependencies: insert,
    });
    const id = await idFor(deps, "DevPilot-27", "set_dependencies");
    const res = await run(deps, { commandId: id, payload: { dependsOn: "DevPilot-12" } });
    expect(res.ok).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it("CONTROL: with no cycle, the edge is written in the right direction", async () => {
    const insert = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(makeDb(baseTables()).db, {
      resolveDependencyRefs: async () => ({
        blockers: [{ ref: "DevPilot-12", ticketId: "t-12", status: "in_progress" }],
        unresolved: [],
      }),
      loadBlockingEdges: async () => [],
      insertDependencies: insert,
    });
    const id = await idFor(deps, "DevPilot-27", "set_dependencies");
    const res = await run(deps, { commandId: id, payload: { dependsOn: "DevPilot-12" } });
    expect(res.ok).toBe(true);
    // DIRECTION: the ticket being held back is `ticket_id`; the blocker is
    // `blocks_ticket_id`. Both orientations store a valid row, and an inverted
    // write orders the board exactly backwards.
    expect(insert).toHaveBeenCalledWith([
      { ticket_id: "t-27", blocks_ticket_id: "t-12", relation_type: "blocked_by" },
    ]);
  });

  it("a FAILED blocker is warned about on an otherwise successful wire", async () => {
    const deps = makeDeps(makeDb(baseTables()).db, {
      resolveDependencyRefs: async () => ({
        blockers: [{ ref: "DevPilot-12", ticketId: "t-12", status: "failed" }],
        unresolved: [],
      }),
      loadBlockingEdges: async () => [],
    });
    const id = await idFor(deps, "DevPilot-27", "set_dependencies");
    const res = await run(deps, { commandId: id, payload: { dependsOn: "DevPilot-12" } });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.applied) throw new Error("expected applied");
    expect(res.summary).toContain("FAILED");
  });

  it("an unresolved blocker adds NOTHING rather than a partial ordering", async () => {
    const insert = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(makeDb(baseTables()).db, {
      resolveDependencyRefs: async () => ({
        blockers: [{ ref: "DevPilot-12", ticketId: "t-12", status: "done" }],
        unresolved: ["DevPilot-4000"],
      }),
      loadBlockingEdges: async () => [],
      insertDependencies: insert,
    });
    const id = await idFor(deps, "DevPilot-27", "set_dependencies");
    const res = await run(deps, {
      commandId: id,
      payload: { dependsOn: "DevPilot-12, DevPilot-4000" },
    });
    expect(res.ok).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it("a goal team starts ONE root run with the operator's ceiling", async () => {
    const start = vi.fn(async () => ({ ok: true as const, runId: "run-1" }));
    const deps = makeDeps(makeDb(baseTables()).db, { startGoalRun: start });
    const id = await idFor(deps, "a goal", "spawn_goal_team");
    const res = await run(deps, {
      commandId: id,
      question: "a goal",
      payload: { goal: "audit the auth flow", role: "tech_lead", budgetCents: 300 },
    });
    expect(res.ok).toBe(true);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ role: "tech_lead", budgetCents: 300, goal: "audit the auth flow" }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The ledger
// ═══════════════════════════════════════════════════════════════════════════

describe("the ledger", () => {
  it("records every commanded change, with the non-defect cause and the operator", async () => {
    const { db, inserted } = makeDb(baseTables());
    const deps = makeDeps(db);
    const id = await idFor(deps, "DevPilot-27", "dispatch_ticket");
    await run(deps, { commandId: id, payload: { role: "qa" }, confirmation: "" });

    const rows = inserted.filter((i) => i.table === "supervisor_actions");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).toMatchObject({
      tenant_id: OURS,
      project_id: PROJECT,
      ticket_id: "t-27",
      // NOT `board_deadlock` / `stalled_ticket`. Those are DEFECT causes the
      // repeat-defect indictment groups on; counting an ordinary dispatch there
      // would accuse a healthy board of being broken for being used. A commanded
      // REMEDIATION still shares them - that is `console-store.ts`'s path and is
      // unchanged.
      cause: "operator_command",
      action: "operator:dispatch_ticket",
    });
    expect(String(rows[0]!.row.detail)).toContain("operator u-1");
  });

  it("writes NO ledger row when the primitive declined", async () => {
    // A ledger that counts repairs that never happened is a ledger nobody can
    // reason from.
    const { db, inserted } = makeDb(baseTables());
    const deps = makeDeps(db, {
      emitDispatch: async () => ({ ok: false, error: "event endpoint unreachable" }),
    });
    const id = await idFor(deps, "DevPilot-27", "dispatch_ticket");
    const res = await run(deps, { commandId: id, payload: { role: "qa" }, confirmation: "" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied).toBe(false);
    expect(inserted.filter((i) => i.table === "supervisor_actions")).toEqual([]);
  });

  it("writes to exactly one table", async () => {
    const { db, inserted } = makeDb(baseTables());
    const deps = makeDeps(db);
    const id = await idFor(deps, "DevPilot-27", "pause_ticket");
    await run(deps, { commandId: id });
    expect([...new Set(inserted.map((i) => i.table))]).toEqual(["supervisor_actions"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Refusals are reported, never worked around
// ═══════════════════════════════════════════════════════════════════════════

describe("a primitive's refusal is reported", () => {
  it("a lost CAS on a move reports rather than clobbering", async () => {
    const deps = makeDeps(makeDb(baseTables()).db, {
      transition: async () => ({ transitioned: false }),
    });
    const id = await idFor(deps, "DevPilot-27", "move_ticket");
    const res = await run(deps, { commandId: id, payload: { to: "in_review" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied).toBe(false);
  });

  it("a THROWN gate refusal becomes a sentence, not a crash", async () => {
    // `transitionTicket` throws for an illegal edge and for the reopen /
    // plan-hold gates. An operator needs the reason, not a stack trace.
    const deps = makeDeps(makeDb(baseTables()).db, {
      transition: async () => {
        throw new Error("transitionTicket: this ticket is held for a pending plan");
      },
    });
    const id = await idFor(deps, "DevPilot-27", "move_ticket");
    const res = await run(deps, { commandId: id, payload: { to: "in_review" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied).toBe(false);
    expect(res.summary).toContain("pending plan");
  });

  it("a ticket already fanned out is refused by the arm, and no dispatch is sent", async () => {
    const emit = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps(makeDb(baseTables({ ticket: { status: "ready" } })).db, {
      armCohortPlan: async () => ({ ok: false, error: "this ticket already has a team on it" }),
      emitDispatch: emit,
    });
    const id = await idFor(deps, "DevPilot-27", "spawn_team");
    const res = await run(deps, {
      commandId: id,
      payload: { roles: ["engineer", "qa"], strategy: "all" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("a refusal never claims nothing changed when a note was written", () => {
  it("says the reason comment IS on the ticket when the move is then refused", async () => {
    // The reason is posted BEFORE the transition so a terminal ticket always
    // carries its explanation. That makes "Nothing changed" untrue on the
    // refusal path, which is exactly the class of copy defect this surface
    // exists to avoid.
    const comment = vi.fn(async () => {});
    const deps = makeDeps(makeDb(baseTables()).db, {
      comment,
      transition: async () => ({ transitioned: false }),
    });
    const id = await idFor(deps, "DevPilot-27", "close_obsolete");
    const res = await run(deps, {
      commandId: id,
      payload: { reason: "superseded" },
      confirmation: "DevPilot-27",
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.applied) throw new Error("expected a refusal");
    expect(comment).toHaveBeenCalled();
    expect(res.summary).toContain("Your note IS on DevPilot-27");
  });

  it("CONTROL: a command with no note says nothing about one", async () => {
    const deps = makeDeps(makeDb(baseTables()).db, {
      transition: async () => ({ transitioned: false }),
    });
    const id = await idFor(deps, "DevPilot-27", "move_ticket");
    const res = await run(deps, { commandId: id, payload: { to: "in_review" } });
    if (!res.ok || res.applied) throw new Error("expected a refusal");
    expect(res.summary).not.toContain("Your note");
  });
});
