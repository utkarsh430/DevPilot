// Agent-declared ticket dependencies - the IO half. Decisions live in the pure
// `ticket-deps.ts`; this file only reads and writes.
//
// TENANT SCOPE IS THE ENTIRE BOUNDARY HERE, and it matters unusually much.
// Every read below is service-role (the caller is a runner-authed route with no
// user session), so RLS is off and the co-located `.eq("tenant_id", …)` is the
// only thing standing between an agent-supplied uuid and another workspace's
// ticket. What a missing predicate would leak is not merely the existence of a
// foreign row: it would WIRE one into this tenant's dependency graph, so a
// ticket here would wait on work in a workspace nobody here can see, forever,
// with the board showing a blocker card nobody can open.
//
// The project predicate sits beside it for the same reason at one level down.
// `POST /api/runners/tools/create-ticket` derives tenant AND project from the
// SPAWNING ticket precisely so an agent cannot file into a project it was never
// dispatched against; a dependency argument must not become the way around
// that, so a blocker is resolved only within that same project.

import { supabaseService } from "@/lib/db/server";
import { BLOCKING_RELATION_TYPES } from "@/lib/board/dependencies";
import type { BlockingEdge, DependencyRef, TicketDependencyRow } from "@/lib/board/ticket-deps";

/** A blocker as resolved from the agent's reference. `ref` is the agent's own
 *  wording, carried through so a refusal or warning quotes what it wrote. */
export type ResolvedBlocker = {
  ref: string;
  ticketId: string;
  status: string;
  ticketNumber: number | null;
};

export type ResolvedDependencies = {
  blockers: ResolvedBlocker[];
  /** The agent's raw strings that matched nothing in this tenant+project. */
  unresolved: string[];
};

/**
 * Resolve every `dependsOn` reference to a ticket in THIS tenant and THIS
 * project. Anything that does not resolve there comes back in `unresolved` -
 * including a ticket that exists in another project or another tenant, which is
 * indistinguishable here on purpose (see `unknown-blocker` in `ticket-deps.ts`).
 *
 * Three narrow reads rather than one `.or(...)`: the forms key on three
 * different columns, and `.or` composes into a filter string that a
 * filter-applying test fake cannot meaningfully apply - which would make the
 * tenant-scope tests below vacuous exactly where they matter most. Each read is
 * skipped when its form is unused, so the common case (no dependencies at all)
 * issues no query.
 */
export async function resolveDependencyRefs(args: {
  tenantId: string;
  projectId: string;
  /** The calling run - aliases are scoped to the run that defined them. */
  runId: string;
  refs: readonly DependencyRef[];
}): Promise<ResolvedDependencies> {
  const { tenantId, projectId, runId, refs } = args;
  if (refs.length === 0) return { blockers: [], unresolved: [] };

  const supabase = supabaseService();
  const cols = "id, status, ticket_number, agent_alias";

  const aliases = refs.filter((r) => r.kind === "alias").map((r) => r.alias);
  const numbers = refs.filter((r) => r.kind === "key").map((r) => r.ticketNumber);
  const ids = refs.filter((r) => r.kind === "uuid").map((r) => r.ticketId);

  type Row = {
    id: string;
    status: string;
    ticket_number: number | null;
    agent_alias: string | null;
  };
  const byAlias = new Map<string, Row>();
  const byNumber = new Map<number, Row>();
  const byId = new Map<string, Row>();

  if (aliases.length > 0) {
    const { data, error } = await supabase
      .from("tickets")
      .select(cols)
      .eq("tenant_id", tenantId)
      .eq("project_id", projectId)
      // An alias belongs to the run that coined it. Scoping here is what keeps
      // one decomposition's labels from resolving inside another's - two runs
      // both using "engine" is entirely likely, and cross-talk would wire an
      // edge to a ticket the agent never saw.
      .eq("source_run_id", runId)
      .in("agent_alias", aliases);
    if (error) throw new Error(`resolveDependencyRefs(alias): ${error.message}`);
    for (const r of (data ?? []) as Row[]) {
      if (r.agent_alias) byAlias.set(r.agent_alias, r);
    }
  }

  if (numbers.length > 0) {
    const { data, error } = await supabase
      .from("tickets")
      .select(cols)
      .eq("tenant_id", tenantId)
      .eq("project_id", projectId)
      .in("ticket_number", numbers);
    if (error) throw new Error(`resolveDependencyRefs(key): ${error.message}`);
    for (const r of (data ?? []) as Row[]) {
      if (typeof r.ticket_number === "number") byNumber.set(r.ticket_number, r);
    }
  }

  if (ids.length > 0) {
    const { data, error } = await supabase
      .from("tickets")
      .select(cols)
      .eq("tenant_id", tenantId)
      .eq("project_id", projectId)
      .in("id", ids);
    if (error) throw new Error(`resolveDependencyRefs(uuid): ${error.message}`);
    for (const r of (data ?? []) as Row[]) byId.set(r.id, r);
  }

  const blockers: ResolvedBlocker[] = [];
  const unresolved: string[] = [];
  const takenRefKeys = new Set<string>();
  for (const ref of refs) {
    const row =
      ref.kind === "alias"
        ? byAlias.get(ref.alias)
        : ref.kind === "key"
          ? byNumber.get(ref.ticketNumber)
          : byId.get(ref.ticketId);
    if (!row) {
      unresolved.push(ref.raw);
      continue;
    }
    // Two different forms can name the SAME ticket ("engine" and "DevPilot-34").
    // The PK is (ticket_id, blocks_ticket_id), so emitting both would collide
    // and fail the whole insert - and they mean one edge anyway.
    if (takenRefKeys.has(row.id)) continue;
    takenRefKeys.add(row.id);
    blockers.push({
      ref: ref.raw,
      ticketId: row.id,
      status: row.status,
      ticketNumber: row.ticket_number,
    });
  }
  return { blockers, unresolved };
}

/** How far the cycle guard walks. A dependency chain deeper than this in one
 *  project is pathological; the guard is defence in depth (see
 *  `planTicketDependencies`), so a bound that stops a runaway walk on a write
 *  path an agent controls is worth more than exhaustiveness. */
const MAX_EDGE_CLOSURE_DEPTH = 12;
const MAX_EDGE_CLOSURE_NODES = 500;

/**
 * Every blocking edge reachable from `fromTicketIds` by following "is blocked
 * by", bounded. Feeds `planTicketDependencies`'s cycle guard.
 *
 * Filters on `BLOCKING_RELATION_TYPES`, never on every row: `ticket_dependencies`
 * is a multi-flavour relations table and an @mention auto-creates a `related`
 * row (`parse-mentions.ts`). A `related` row has never blocked anything, so
 * treating one as an edge here would refuse a perfectly legal dependency
 * because two tickets happened to mention each other.
 */
export async function loadBlockingEdgeClosure(args: {
  tenantId: string;
  fromTicketIds: readonly string[];
}): Promise<BlockingEdge[]> {
  const { tenantId, fromTicketIds } = args;
  if (fromTicketIds.length === 0) return [];
  const supabase = supabaseService();

  const edges: BlockingEdge[] = [];
  const visited = new Set<string>();
  let frontier = [...new Set(fromTicketIds)];

  for (let depth = 0; depth < MAX_EDGE_CLOSURE_DEPTH && frontier.length > 0; depth++) {
    const batch = frontier.filter((id) => !visited.has(id));
    if (batch.length === 0) break;
    for (const id of batch) visited.add(id);
    if (visited.size > MAX_EDGE_CLOSURE_NODES) break;

    const { data, error } = await supabase
      .from("ticket_dependencies")
      .select("ticket_id, blocks_ticket_id")
      .in("ticket_id", batch)
      .in("relation_type", BLOCKING_RELATION_TYPES as unknown as string[]);
    if (error) {
      // Do NOT fail open into "no edges, therefore no cycle". An unreadable
      // graph means we cannot tell, and the caller must not conclude "safe".
      throw new Error(`loadBlockingEdgeClosure: ${error.message}`);
    }

    const discovered = [
      ...new Set(
        ((data ?? []) as Array<{ blocks_ticket_id: string }>).map((r) => r.blocks_ticket_id),
      ),
    ];
    // `ticket_dependencies` has no tenant column of its own, so the scope has to
    // be re-established on the tickets it names before the walk continues. Every
    // id in `batch` was already proven ours (the seed is the resolved blocker
    // set, and each later level passes through here); this is what keeps that
    // true one hop further out. Dropping a foreign node cannot hide a real cycle
    // - the node we are looking for is ours by construction - and keeping one
    // could invent a cycle out of another workspace's graph.
    const inTenant = await filterTicketsInTenant(discovered, tenantId);

    const next: string[] = [];
    for (const row of (data ?? []) as Array<{ ticket_id: string; blocks_ticket_id: string }>) {
      if (!inTenant.has(row.blocks_ticket_id)) continue;
      edges.push({ ticketId: row.ticket_id, blocksTicketId: row.blocks_ticket_id });
      if (!visited.has(row.blocks_ticket_id)) next.push(row.blocks_ticket_id);
    }
    frontier = next;
  }
  return edges;
}

async function filterTicketsInTenant(
  ids: readonly string[],
  tenantId: string,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("id", ids as string[]);
  if (error) throw new Error(`loadBlockingEdgeClosure(tenant filter): ${error.message}`);
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
}

/**
 * Is this run already using `alias` for a different ticket?
 *
 * Checked in the app as well as enforced by the partial unique index, because a
 * unique-violation at insert time would surface as a generic 500 after the slot
 * was already claimed - i.e. a refusal that burns one of the run's ticket slots
 * and says nothing useful. The index remains the boundary; this is the readable
 * refusal in front of it.
 */
export async function aliasTakenThisRun(args: {
  tenantId: string;
  runId: string;
  alias: string;
}): Promise<boolean> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("source_run_id", args.runId)
    .eq("agent_alias", args.alias)
    .limit(1);
  if (error) throw new Error(`aliasTakenThisRun: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Every alias this run has coined so far.
 *
 * Read only to build the `unknown-blocker` refusal, and that is the whole point
 * of it: an agent that mistypes an alias gets back the small closed set of
 * labels that DO exist on its run, which turns a dead-end "not found" into a
 * one-step correction. Bounded by the per-run ticket cap, so no limit is needed.
 */
export async function loadRunAliases(args: {
  tenantId: string;
  projectId: string;
  runId: string;
}): Promise<string[]> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("agent_alias")
    .eq("tenant_id", args.tenantId)
    // Scoped identically to `resolveDependencyRefs`, deliberately: this list is
    // shown as "the aliases you can reference", so a name in it that resolution
    // would then reject is worse than a shorter list.
    .eq("project_id", args.projectId)
    .eq("source_run_id", args.runId)
    .not("agent_alias", "is", null);
  if (error) {
    // Cosmetic enrichment of a refusal that is already correct without it -
    // never turn a readable refusal into a 500.
    console.warn(`[ticket-deps] loadRunAliases failed for run ${args.runId}: ${error.message}`);
    return [];
  }
  return ((data ?? []) as Array<{ agent_alias: string | null }>)
    .map((r) => r.agent_alias)
    .filter((a): a is string => typeof a === "string" && a.length > 0)
    .sort();
}

/**
 * Write the edges. ONE insert of every row, so the set lands whole or not at
 * all - a decomposition that recorded three of five edges would be the original
 * bug with extra steps.
 *
 * Returns ok/failed rather than throwing: the ticket already exists by this
 * point, and the caller reports the failure loudly instead of turning a created
 * ticket into a 500 the agent would answer by filing it again.
 */
export async function insertTicketDependencies(
  rows: readonly TicketDependencyRow[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (rows.length === 0) return { ok: true };
  const supabase = supabaseService();
  const { error } = await supabase
    .from("ticket_dependencies")
    .insert(rows as TicketDependencyRow[]);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
