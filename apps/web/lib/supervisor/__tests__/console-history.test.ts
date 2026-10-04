// The console transcript: the pure rules, and the store's tenant scoping.
//
// The store's fake ACTUALLY APPLIES `.eq`, and every scoping assertion has a
// CONTROL that neuters the predicate and shows the foreign row WOULD come back.
// A filter-ignoring fake makes the whole suite vacuous, which is the shape this
// repo has been bitten by before.

import { describe, expect, it } from "vitest";
import {
  asConsoleMessageKind,
  asConsoleMessageRole,
  boundConsoleMessageBody,
  CONSOLE_HISTORY_CONTEXT_TURNS,
  CONSOLE_MESSAGE_MAX_CHARS,
  CONSOLE_THREAD_DISPLAY_LIMIT,
  decideConsoleMessageLink,
  toModelContextTurns,
  type ConsoleMessage,
} from "@/lib/supervisor/console-history";
import {
  appendConsoleMessage,
  loadConsoleMessageById,
  loadConsoleThread,
} from "@/lib/supervisor/console-history-store";

const OURS = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-04T12:00:00.000Z";

type Row = Record<string, unknown>;

/** A Supabase double that APPLIES its filters. `ignore` neuters one column's
 *  predicate so a control can prove the guard is what excluded the row. */
function makeDb(
  rows: Row[],
  opts: { ignore?: string; failRead?: boolean; failInsert?: boolean } = {},
) {
  const inserted: Row[] = [];
  const db = {
    from(table: string) {
      let view = table === "supervisor_console_messages" ? [...rows] : [];
      let desc = false;
      let cap: number | null = null;
      const builder = {
        select() {
          return builder;
        },
        insert(row: Row) {
          inserted.push(row);
          return {
            select: () => ({
              maybeSingle: () =>
                Promise.resolve(
                  opts.failInsert
                    ? { data: null, error: { message: "insert failed" } }
                    : { data: { id: "new-id" }, error: null },
                ),
            }),
          };
        },
        eq(col: string, val: unknown) {
          if (col === opts.ignore) return builder;
          view = view.filter((r) => r[col] === val);
          return builder;
        },
        order(_col: string, o?: { ascending?: boolean }) {
          desc = o?.ascending === false;
          return builder;
        },
        limit(n: number) {
          cap = n;
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(
            opts.failRead
              ? { data: null, error: { message: "read failed" } }
              : { data: view[0] ?? null, error: null },
          );
        },
        then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) {
          const sorted = [...view].sort((a, b) =>
            desc
              ? String(b.created_at).localeCompare(String(a.created_at))
              : String(a.created_at).localeCompare(String(b.created_at)),
          );
          const out = cap === null ? sorted : sorted.slice(0, cap);
          return Promise.resolve(
            resolve(
              opts.failRead
                ? { data: null, error: { message: "read failed" } }
                : { data: out, error: null },
            ),
          );
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, inserted };
}

function deps(db: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, nowIso: NOW };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "m-1",
    tenant_id: OURS,
    project_id: PROJECT,
    role: "operator",
    kind: "ask",
    body: "why is nothing moving?",
    created_at: "2026-08-04T11:00:00.000Z",
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Pure rules
// ───────────────────────────────────────────────────────────────────────────

describe("boundConsoleMessageBody", () => {
  it("keeps ordinary text", () => {
    expect(boundConsoleMessageBody("  hello  ")).toBe("hello");
  });

  it("refuses an empty turn - the console never said nothing", () => {
    expect(boundConsoleMessageBody("")).toBeNull();
    expect(boundConsoleMessageBody("   \n\t ")).toBeNull();
  });

  it("bounds a runaway body", () => {
    const out = boundConsoleMessageBody("x".repeat(CONSOLE_MESSAGE_MAX_CHARS * 3));
    expect(out).toHaveLength(CONSOLE_MESSAGE_MAX_CHARS);
  });

  // The stored bound must not be TIGHTER than the schema's own answer ceiling,
  // or the transcript records something other than what the operator read.
  it("is at least as wide as the reply schema's answer field", () => {
    expect(CONSOLE_MESSAGE_MAX_CHARS).toBeGreaterThanOrEqual(6000);
  });
});

describe("role and kind narrowing", () => {
  it("accepts only the two speakers", () => {
    expect(asConsoleMessageRole("operator")).toBe("operator");
    expect(asConsoleMessageRole("console")).toBe("console");
    for (const bad of ["agent", "system", "", null, 7]) {
      expect(asConsoleMessageRole(bad)).toBeNull();
    }
  });

  it("degrades an unknown kind rather than dropping the turn", () => {
    // The TEXT is what matters. Losing a message because a later version of the
    // app labelled it differently would be a transcript with holes in it.
    expect(asConsoleMessageKind("something_new", "operator")).toBe("ask");
    expect(asConsoleMessageKind(undefined, "console")).toBe("notice");
    expect(asConsoleMessageKind("model_failure", "console")).toBe("model_failure");
  });
});

describe("toModelContextTurns", () => {
  const many: ConsoleMessage[] = Array.from({ length: 30 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "operator" : "console",
    kind: "ask",
    body: `turn ${i}`,
    createdAtIso: NOW,
  }));

  it("replays only the tail, oldest first", () => {
    const out = toModelContextTurns(many);
    expect(out).toHaveLength(CONSOLE_HISTORY_CONTEXT_TURNS);
    expect(out[out.length - 1]!.text).toBe("turn 29");
  });

  // The replayed window is the cost bound. A thread that grows for a month must
  // not grow the prompt with it.
  it("is far smaller than the display window", () => {
    expect(CONSOLE_HISTORY_CONTEXT_TURNS).toBeLessThan(CONSOLE_THREAD_DISPLAY_LIMIT);
  });

  it("bounds each replayed turn", () => {
    const out = toModelContextTurns([
      { id: "a", role: "console", kind: "answer", body: "y".repeat(9000), createdAtIso: NOW },
    ]);
    expect(out[0]!.text.length).toBeLessThanOrEqual(1200);
  });

  it("carries the role through, so the prompt can label who spoke", () => {
    const out = toModelContextTurns(many.slice(-2));
    expect(out.map((t) => t.role)).toEqual(["operator", "console"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The audit link
// ───────────────────────────────────────────────────────────────────────────

describe("decideConsoleMessageLink", () => {
  const message = { id: "m-1", role: "operator" as const, body: "unstick DevPilot-7" };

  it("links when the stored message IS the question", () => {
    expect(
      decideConsoleMessageLink({ messageId: "m-1", message, question: "unstick DevPilot-7" }),
    ).toEqual({ link: true, messageId: "m-1" });
  });

  it("no id means no link, and that is not an error", () => {
    // An action run from the report is caused by no message. `null` in the
    // ledger is a true statement about it.
    for (const id of [null, undefined, "", "   "]) {
      expect(decideConsoleMessageLink({ messageId: id, message, question: "x" })).toEqual({
        link: false,
        reason: "no-id",
      });
    }
  });

  it("refuses an id that resolved to nothing", () => {
    // A foreign-tenant or wrong-project id resolves to null in the store, which
    // is what makes it unreachable here.
    expect(
      decideConsoleMessageLink({ messageId: "m-1", message: null, question: "unstick DevPilot-7" }),
    ).toEqual({ link: false, reason: "not-found" });
  });

  it("refuses when the loaded row is a different message", () => {
    expect(
      decideConsoleMessageLink({
        messageId: "m-1",
        message: { ...message, id: "m-2" },
        question: "unstick DevPilot-7",
      }),
    ).toEqual({ link: false, reason: "not-found" });
  });

  it("refuses to attribute a fix to the console's own turn", () => {
    expect(
      decideConsoleMessageLink({
        messageId: "m-1",
        message: { ...message, role: "console" },
        question: "unstick DevPilot-7",
      }),
    ).toEqual({ link: false, reason: "not-operator" });
  });

  // THE ONE THAT MATTERS. A client sending the id of one message and the text
  // of another would produce a ledger row pointing at a turn that says
  // something else - a confidently wrong audit trail, which is worse than a gap.
  it("refuses when the stored message says something other than the question", () => {
    expect(
      decideConsoleMessageLink({
        messageId: "m-1",
        message,
        question: "close DevPilot-99 as obsolete",
      }),
    ).toEqual({ link: false, reason: "text-mismatch" });
  });

  it("tolerates the whitespace the store trims on the way in", () => {
    expect(
      decideConsoleMessageLink({
        messageId: "m-1",
        message,
        question: "  unstick DevPilot-7  ",
      }).link,
    ).toBe(true);
  });

  it("does not judge a capped question a mismatch against its own truncated record", () => {
    const long = "a".repeat(CONSOLE_MESSAGE_MAX_CHARS + 500);
    const stored = boundConsoleMessageBody(long)!;
    expect(
      decideConsoleMessageLink({
        messageId: "m-1",
        message: { id: "m-1", role: "operator", body: stored },
        question: long,
      }).link,
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Store: tenant + project scoping
// ───────────────────────────────────────────────────────────────────────────

describe("loadConsoleThread", () => {
  it("returns this project's thread, oldest first", async () => {
    const { db } = makeDb([
      row({ id: "a", created_at: "2026-08-04T10:00:00.000Z", body: "first" }),
      row({ id: "b", created_at: "2026-08-04T11:00:00.000Z", body: "second", role: "console" }),
    ]);
    const out = await loadConsoleThread(deps(db), { tenantId: OURS, projectId: PROJECT });
    expect(out.map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("never returns another tenant's conversation", async () => {
    // What leaks is not just text: it is replayed into THIS tenant's model
    // context and rendered as this operator's own thread.
    const { db } = makeDb([row({ id: "theirs", tenant_id: THEIRS, body: "their board" })]);
    const out = await loadConsoleThread(deps(db), { tenantId: OURS, projectId: PROJECT });
    expect(out).toEqual([]);
  });

  it("CONTROL: with the tenant predicate neutered, the foreign turn IS returned", async () => {
    const { db } = makeDb([row({ id: "theirs", tenant_id: THEIRS, body: "their board" })], {
      ignore: "tenant_id",
    });
    const out = await loadConsoleThread(deps(db), { tenantId: OURS, projectId: PROJECT });
    expect(out.map((m) => m.body)).toEqual(["their board"]);
  });

  it("never returns another project's conversation", async () => {
    const { db } = makeDb([row({ id: "other", project_id: OTHER_PROJECT, body: "other board" })]);
    expect(await loadConsoleThread(deps(db), { tenantId: OURS, projectId: PROJECT })).toEqual([]);
  });

  it("CONTROL: with the project predicate neutered, the other board's turn IS returned", async () => {
    const { db } = makeDb([row({ id: "other", project_id: OTHER_PROJECT, body: "other board" })], {
      ignore: "project_id",
    });
    const out = await loadConsoleThread(deps(db), { tenantId: OURS, projectId: PROJECT });
    expect(out.map((m) => m.body)).toEqual(["other board"]);
  });

  it("reads NEWEST first with a cap, so 'the last N' is the tail and not the head", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `m${i}`, body: `turn ${i}`, created_at: `2026-08-04T1${i}:00:00.000Z` }),
    );
    const { db } = makeDb(rows);
    const out = await loadConsoleThread(deps(db), { tenantId: OURS, projectId: PROJECT, limit: 3 });
    expect(out.map((m) => m.body)).toEqual(["turn 7", "turn 8", "turn 9"]);
  });

  it("a failed read is an empty thread, never a throw", async () => {
    // The console must still open. The deterministic board brief - the reason
    // this surface exists - needs none of the transcript.
    const { db } = makeDb([row()], { failRead: true });
    await expect(
      loadConsoleThread(deps(db), { tenantId: OURS, projectId: PROJECT }),
    ).resolves.toEqual([]);
  });

  it("drops a row it cannot make sense of rather than rendering a blank turn", async () => {
    const { db } = makeDb([
      row({ id: "ok" }),
      row({ id: "bad", role: "agent" }),
      row({ id: "e", body: "  " }),
    ]);
    const out = await loadConsoleThread(deps(db), { tenantId: OURS, projectId: PROJECT });
    expect(out.map((m) => m.id)).toEqual(["ok"]);
  });
});

describe("loadConsoleMessageById", () => {
  it("resolves our own message", async () => {
    const { db } = makeDb([row({ id: "m-1" })]);
    const out = await loadConsoleMessageById(deps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      messageId: "m-1",
    });
    expect(out?.id).toBe("m-1");
  });

  it("never resolves another tenant's message", async () => {
    // This is the id a commanded fix would be attributed to. A foreign hit
    // would be an audit trail pointing into another workspace.
    const { db } = makeDb([row({ id: "m-1", tenant_id: THEIRS })]);
    expect(
      await loadConsoleMessageById(deps(db), {
        tenantId: OURS,
        projectId: PROJECT,
        messageId: "m-1",
      }),
    ).toBeNull();
  });

  it("CONTROL: with the tenant predicate neutered, the foreign message IS resolved", async () => {
    const { db } = makeDb([row({ id: "m-1", tenant_id: THEIRS })], { ignore: "tenant_id" });
    expect(
      (
        await loadConsoleMessageById(deps(db), {
          tenantId: OURS,
          projectId: PROJECT,
          messageId: "m-1",
        })
      )?.id,
    ).toBe("m-1");
  });

  it("never resolves another project's message", async () => {
    const { db } = makeDb([row({ id: "m-1", project_id: OTHER_PROJECT })]);
    expect(
      await loadConsoleMessageById(deps(db), {
        tenantId: OURS,
        projectId: PROJECT,
        messageId: "m-1",
      }),
    ).toBeNull();
  });

  it("does not query at all for a blank id", async () => {
    const { db } = makeDb([row({ id: "m-1" })]);
    expect(
      await loadConsoleMessageById(deps(db), {
        tenantId: OURS,
        projectId: PROJECT,
        messageId: " ",
      }),
    ).toBeNull();
  });
});

describe("appendConsoleMessage", () => {
  it("stamps the tenant, the project and the author", async () => {
    const { db, inserted } = makeDb([]);
    const res = await appendConsoleMessage(deps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      role: "operator",
      kind: "ask",
      body: "  why is nothing moving?  ",
      authorUserId: "u-1",
    });
    expect(res).toEqual({ ok: true, id: "new-id" });
    expect(inserted[0]).toMatchObject({
      tenant_id: OURS,
      project_id: PROJECT,
      role: "operator",
      kind: "ask",
      body: "why is nothing moving?",
      author_user_id: "u-1",
    });
  });

  it("never attributes a console turn to a person - nobody typed it", async () => {
    const { db, inserted } = makeDb([]);
    await appendConsoleMessage(deps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      role: "console",
      kind: "answer",
      body: "DevPilot-1 is the only active ticket.",
      authorUserId: "u-1",
    });
    expect(inserted[0]!.author_user_id).toBeNull();
  });

  it("refuses an empty turn without touching the database", async () => {
    const { db, inserted } = makeDb([]);
    expect(
      await appendConsoleMessage(deps(db), {
        tenantId: OURS,
        projectId: PROJECT,
        role: "console",
        kind: "notice",
        body: "   ",
      }),
    ).toEqual({ ok: false });
    expect(inserted).toEqual([]);
  });

  it("a failed write is reported, never thrown", async () => {
    // Losing the record of a conversation must not fail the question the
    // operator asked, or take down a recovery because we could not write it
    // down.
    const { db } = makeDb([], { failInsert: true });
    await expect(
      appendConsoleMessage(deps(db), {
        tenantId: OURS,
        projectId: PROJECT,
        role: "operator",
        kind: "ask",
        body: "hello",
      }),
    ).resolves.toEqual({ ok: false });
  });

  it("bounds the stored body", async () => {
    const { db, inserted } = makeDb([]);
    await appendConsoleMessage(deps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      role: "console",
      kind: "answer",
      body: "z".repeat(CONSOLE_MESSAGE_MAX_CHARS * 2),
    });
    expect(String(inserted[0]!.body)).toHaveLength(CONSOLE_MESSAGE_MAX_CHARS);
  });
});
