// The background dep-suggester is what makes ticket creation instant: the Haiku
// "which existing tickets block this new one?" rerank used to run inline in
// `createTicketCore` and hung the "Creating…" button. It now runs here, off the
// request path, and parks the ranked result on `tickets.suggested_dependencies`
// for the operator to accept/skip. These tests pin:
//   • it calls the SAME shared `loadAndSuggestDeps` rerank and persists a
//     non-empty result to the row,
//   • an empty rank writes nothing (no chip on an unremarkable ticket),
//   • it never touches a ticket that's already past pre-dispatch,
//   • a rerank/persist failure returns {ok:false} rather than throwing (the
//     create already succeeded; a suggestion failure must be inert).

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  loadAndSuggestDeps: vi.fn(),
  // The ticket the status/load select resolves to.
  ticketRow: { id: "new-ticket", status: "backlog" } as Record<string, unknown> | null,
  loadErr: null as { message: string } | null,
  updateErr: null as { message: string } | null,
  // Captured update payload so we can assert what got parked (and on what row).
  updates: [] as Array<{ payload: Record<string, unknown>; eqs: string[]; statusIn?: string[] }>,
}));

vi.mock("@/lib/engine/inngest", () => ({
  // createFunction is called at module import; return an inert value.
  inngest: { createFunction: () => ({}), send: vi.fn() },
}));
vi.mock("@/lib/board/create-ticket", () => ({
  loadAndSuggestDeps: h.loadAndSuggestDeps,
}));
vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({
    from: (_table: string) => ({
      // Load path: .select(...).eq().eq().maybeSingle()
      select: () => {
        const node: Record<string, unknown> = {
          maybeSingle: async () => ({ data: h.ticketRow, error: h.loadErr }),
        };
        node.eq = () => node;
        return node;
      },
      // Persist path: .update(payload).eq().eq().in(status,[...]) → {error}
      update: (payload: Record<string, unknown>) => {
        const rec = { payload, eqs: [] as string[], statusIn: undefined as string[] | undefined };
        const node: Record<string, unknown> = {
          in: async (_col: string, vals: string[]) => {
            rec.statusIn = vals;
            h.updates.push(rec);
            return { error: h.updateErr };
          },
        };
        node.eq = (_col: string, val: string) => {
          rec.eqs.push(String(val));
          return node;
        };
        return node;
      },
    }),
  }),
}));

import { suggestTicketDepsInBackground } from "@/lib/engine/ticket-dep-suggester";

const BASE = {
  ticketId: "new-ticket",
  tenantId: "tn",
  projectId: "pj",
  title: "Add password reset",
  description: "let users reset via email",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.ticketRow = { id: "new-ticket", status: "backlog" };
  h.loadErr = null;
  h.updateErr = null;
  h.updates = [];
  h.loadAndSuggestDeps.mockResolvedValue([]);
});

describe("suggestTicketDepsInBackground", () => {
  it("runs the shared rerank and parks a non-empty result on the ticket row", async () => {
    const suggestions = [
      { ticketId: "b1", score: 9, rationale: "auth first", title: "Build auth", status: "backlog" },
    ];
    h.loadAndSuggestDeps.mockResolvedValue(suggestions);

    const res = await suggestTicketDepsInBackground(BASE);

    expect(h.loadAndSuggestDeps).toHaveBeenCalledWith({
      tenantId: "tn",
      projectId: "pj",
      newTicketId: "new-ticket",
      title: BASE.title,
      description: BASE.description,
    });
    expect(res).toEqual({ ok: true, parked: 1 });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.payload).toEqual({ suggested_dependencies: suggestions });
    // Scoped to the ticket + tenant, and re-gated on pre-dispatch status so a
    // promotion during the Haiku call means the write matches no row.
    expect(h.updates[0]!.eqs).toEqual(["new-ticket", "tn"]);
    expect(h.updates[0]!.statusIn).toEqual(["backlog", "ready"]);
  });

  it("writes nothing when the rerank returns no suggestions", async () => {
    h.loadAndSuggestDeps.mockResolvedValue([]);
    const res = await suggestTicketDepsInBackground(BASE);
    expect(res).toEqual({ ok: true, parked: 0 });
    expect(h.updates).toHaveLength(0);
  });

  it("no-ops (never reranks) when the ticket is past pre-dispatch", async () => {
    h.ticketRow = { id: "new-ticket", status: "in_progress" };
    const res = await suggestTicketDepsInBackground(BASE);
    expect(res).toEqual({ ok: false, reason: "past-pre-dispatch-status:in_progress" });
    expect(h.loadAndSuggestDeps).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
  });

  it("returns not-found when the ticket is gone, without reranking", async () => {
    h.ticketRow = null;
    const res = await suggestTicketDepsInBackground(BASE);
    expect(res).toEqual({ ok: false, reason: "ticket-not-found" });
    expect(h.loadAndSuggestDeps).not.toHaveBeenCalled();
  });

  it("returns {ok:false} (does not throw) when the persist fails", async () => {
    h.loadAndSuggestDeps.mockResolvedValue([
      { ticketId: "b1", score: 8, rationale: "x", title: "t", status: "backlog" },
    ]);
    h.updateErr = { message: "db exploded" };
    const res = await suggestTicketDepsInBackground(BASE);
    expect(res.ok).toBe(false);
  });
});
