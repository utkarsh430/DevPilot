// Tenant scoping for the ambient activity read.
//
// The fake below ACTUALLY APPLIES `.eq` / `.in` / `.limit` against a fixture
// table. That is the entire point: a fake that records calls but returns a
// fixed array makes every assertion here vacuous — it would pass just as
// happily with the tenant predicate deleted. Each guard therefore also has a
// CONTROL that neuters the predicate and proves the foreign row WOULD surface,
// so the suite is demonstrably non-vacuous.
//
// Severity note: this surface renders in the chrome of EVERY page. A foreign
// run leaking here does not merely disclose another workspace's work — it tells
// this operator an agent is working for him when it is working for someone
// else, which is a lie he would act on.

import { describe, it, expect } from "vitest";
import {
  fetchActiveRuns,
  MAX_TRACKED,
  type ActivityQueryClient,
  type RawActivityRow,
} from "../query";

const OURS = "aaaaaaaa-0000-0000-0000-000000000001";
const THEIRS = "bbbbbbbb-0000-0000-0000-000000000002";

function row(over: Partial<RawActivityRow> = {}): RawActivityRow {
  return {
    id: "run-1",
    tenant_id: OURS,
    status: "running",
    runner_kind: "local-cc",
    agent_id: "agent-1",
    ticket_id: "ticket-1",
    parent_run_id: null,
    fan_out_role: null,
    created_at: "2026-07-19T10:00:00.000Z",
    last_event_at: null,
    agents: { role: "engineer" },
    tickets: {
      title: "Add the thing",
      ticket_number: 7,
      project_id: "proj-1",
      projects: { name: "DevPilot" },
    },
    ...over,
  };
}

type FakeOpts = {
  /** CONTROL knob: when true the fake ignores `.eq`, as a missing predicate would. */
  ignoreEq?: boolean;
  /** CONTROL knob: when true the fake ignores `.in`. */
  ignoreIn?: boolean;
};

type Recorded = { table: string; eq: [string, string][]; in: [string, readonly string[]][] };

/**
 * A query builder that genuinely filters. `.eq`/`.in`/`.limit` narrow the
 * fixture exactly as PostgREST would, so deleting a predicate from the accessor
 * changes what these tests observe.
 */
function fakeClient(
  table: RawActivityRow[],
  opts: FakeOpts = {},
): { client: ActivityQueryClient; recorded: Recorded } {
  const recorded: Recorded = { table: "", eq: [], in: [] };
  return {
    recorded,
    client: {
      from(name: string) {
        recorded.table = name;
        return {
          select() {
            let working = [...table];
            const builder = {
              eq(column: string, value: string) {
                recorded.eq.push([column, value]);
                if (!opts.ignoreEq) {
                  working = working.filter(
                    (r) => (r as unknown as Record<string, unknown>)[column] === value,
                  );
                }
                return builder;
              },
              in(column: string, values: readonly string[]) {
                recorded.in.push([column, values]);
                if (!opts.ignoreIn) {
                  working = working.filter((r) =>
                    values.includes((r as unknown as Record<string, unknown>)[column] as string),
                  );
                }
                return builder;
              },
              order() {
                return builder;
              },
              limit(n: number) {
                return Promise.resolve({ data: working.slice(0, n), error: null });
              },
            };
            return builder;
          },
        };
      },
    },
  };
}

describe("tenant scoping", () => {
  it("never returns another tenant's active runs", async () => {
    const { client } = fakeClient([
      row({ id: "ours", tenant_id: OURS }),
      row({ id: "theirs", tenant_id: THEIRS }),
    ]);
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows.map((r) => r.id)).toEqual(["ours"]);
  });

  it("CONTROL: with the tenant predicate neutered the foreign run DOES surface", async () => {
    // Proves the assertion above is not vacuous — the fake is capable of
    // returning the foreign row, and only the predicate stops it.
    const { client } = fakeClient(
      [row({ id: "ours", tenant_id: OURS }), row({ id: "theirs", tenant_id: THEIRS })],
      { ignoreEq: true },
    );
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows.map((r) => r.id).sort()).toEqual(["ours", "theirs"]);
  });

  it("returns an empty set for a tenant with only foreign runs in flight", async () => {
    const { client } = fakeClient([
      row({ id: "theirs-a", tenant_id: THEIRS }),
      row({ id: "theirs-b", tenant_id: THEIRS, status: "awaiting_human" }),
    ]);
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows).toEqual([]);
  });

  it("issues the tenant predicate against the runs table", async () => {
    const { client, recorded } = fakeClient([]);
    await fetchActiveRuns(client, OURS);
    expect(recorded.table).toBe("runs");
    expect(recorded.eq).toContainEqual(["tenant_id", OURS]);
  });
});

describe("status scoping", () => {
  it("fetches only running and awaiting_human", async () => {
    const { client } = fakeClient([
      row({ id: "live", status: "running" }),
      row({ id: "parked", status: "awaiting_human" }),
      row({ id: "done", status: "done" }),
      row({ id: "failed", status: "failed" }),
      row({ id: "cancelled", status: "cancelled" }),
    ]);
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows.map((r) => r.id).sort()).toEqual(["live", "parked"]);
  });

  it("CONTROL: with the status predicate neutered terminal runs DO surface", async () => {
    const { client } = fakeClient(
      [row({ id: "live", status: "running" }), row({ id: "done", status: "done" })],
      { ignoreIn: true },
    );
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows.map((r) => r.id).sort()).toEqual(["done", "live"]);
  });
});

describe("row mapping", () => {
  it("resolves the producer role as COALESCE(fan_out_role, agents.role)", async () => {
    const { client } = fakeClient([
      row({ id: "sibling", agent_id: null, fan_out_role: "qa", agents: null }),
    ]);
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows[0]?.role).toBe("qa");
  });

  it("prefers fan_out_role over the agent's own role", async () => {
    const { client } = fakeClient([
      row({ id: "sibling", fan_out_role: "qa", agents: { role: "engineer" } }),
    ]);
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows[0]?.role).toBe("qa");
  });

  it("carries ticket and project detail for the popover", async () => {
    const { client } = fakeClient([row()]);
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows[0]).toMatchObject({
      ticketTitle: "Add the thing",
      ticketNumber: 7,
      projectId: "proj-1",
      projectName: "DevPilot",
      role: "engineer",
    });
  });

  it("tolerates a ticket-less run without inventing detail", async () => {
    const { client } = fakeClient([
      row({ id: "child", ticket_id: null, tickets: null, parent_run_id: "parent" }),
    ]);
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows[0]).toMatchObject({
      ticketTitle: null,
      ticketNumber: null,
      projectId: null,
      projectName: null,
    });
  });

  it("caps the number of rows pulled", async () => {
    const many = Array.from({ length: MAX_TRACKED + 25 }, (_, i) => row({ id: `run-${i}` }));
    const { client } = fakeClient(many);
    const { rows } = await fetchActiveRuns(client, OURS);
    expect(rows).toHaveLength(MAX_TRACKED);
  });
});

describe("error handling", () => {
  it("surfaces the error rather than reporting a falsely idle tenant", async () => {
    const failing: ActivityQueryClient = {
      from: () => ({
        select: () => {
          const b = {
            eq: () => b,
            in: () => b,
            order: () => b,
            limit: () =>
              Promise.resolve({ data: null, error: { code: "PGRST201", message: "ambiguous" } }),
          };
          return b;
        },
      }),
    };
    const { rows, error } = await fetchActiveRuns(failing, OURS);
    expect(rows).toEqual([]);
    // The caller LOGS on a non-null error; an idle tenant returns error === null.
    // Conflating the two is what would make a broken embed look healthy.
    expect(error).not.toBeNull();
  });
});
