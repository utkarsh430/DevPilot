// Phase 2.5+ / G3 — Shared topological / placement helpers for the board.
//
// `computeTopoOrder` is extracted verbatim from `commitPlanAction` in
// `apps/web/app/(app)/plan/actions.ts` (the original location around L131-169
// of the pre-extraction file — search for "Kahn's algorithm" in the git
// history if you want the inline context). Keeping the signature identical so
// the in-place import swap in `commitPlanAction` is a pure refactor, no
// semantic change.
//
// `computePlacementAfterBlockers` is new (G3-only) and is used by
// `acceptTicketDependenciesAction` to drop the just-created ticket *after*
// its picked blockers on the board. The math mirrors the 1024-spacing
// convention `commitPlanAction` already uses, so chained creates don't
// collide and there's room to re-order between picked blockers later.

import { supabaseService } from "@/lib/db/server";

// ─── computeTopoOrder ──────────────────────────────────────────────────────
//
// Kahn's algorithm with a stable tiebreak on the original ordinal. Returns
// an array of ordinals in topo order, where every dependency appears before
// the ticket that depends on it. Returns a SHORTER array than `nodes` when
// the DAG contains a cycle — the caller is expected to detect this and fall
// back to the plain ordinal order with a console.warn.
//
// Pre-condition: every `deps` array contains ONLY ordinals that exist in
// `nodes` — the caller filters out cross-batch dependencies before invoking.

export function computeTopoOrder(nodes: Array<{ ordinal: number; deps: number[] }>): number[] {
  const all = nodes.map((n) => n.ordinal).sort((a, b) => a - b);
  const depsByOrdinal = new Map<number, number[]>();
  const inDegree = new Map<number, number>();
  for (const o of all) {
    depsByOrdinal.set(o, []);
    inDegree.set(o, 0);
  }
  for (const n of nodes) {
    for (const d of n.deps) {
      // edge: d → n.ordinal (d must come first)
      depsByOrdinal.get(d)!.push(n.ordinal);
      inDegree.set(n.ordinal, (inDegree.get(n.ordinal) ?? 0) + 1);
    }
  }
  // Priority "queue" is just a sorted array we mutate — set sizes are small
  // (≤25 per commit) so the O(N²) shape is fine.
  const ready: number[] = all.filter((o) => (inDegree.get(o) ?? 0) === 0).sort((a, b) => a - b);
  const out: number[] = [];
  while (ready.length > 0) {
    const o = ready.shift()!;
    out.push(o);
    for (const next of depsByOrdinal.get(o) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        // Insert preserving ascending order on ordinal so ties stay stable.
        let i = 0;
        while (i < ready.length && ready[i]! < next) i++;
        ready.splice(i, 0, next);
      }
    }
  }
  return out;
}

// ─── computePlacementAfterBlockers ─────────────────────────────────────────
//
// Returns a new `tickets.column_position` value that places the new ticket
// AFTER its highest-positioned blocker (or, if there are no blockers, at
// the end of the project's backlog column). The 1024 spacing matches the
// convention used by `commitPlanAction` so a future re-order between two
// existing rows has room to land mid-way.
//
// Service-role read (we may be called from a server action that's already past
// the RLS-bound tenant gate) — so every query below carries its own
// `tenant_id` predicate. This used to reason "the rows are project-scoped so
// cross-tenant leakage isn't a concern", which is exactly the inference this
// codebase has had to unlearn: a clean PARENT id does not imply a clean CHILD
// row, because `tickets` carries its own `tenant_id` and the member write
// policy pins only that, never the `project_id` it names.

export async function computePlacementAfterBlockers(input: {
  projectId: string;
  tenantId: string;
  blockerIds: string[];
}): Promise<number> {
  const supabase = supabaseService();

  if (input.blockerIds.length === 0) {
    // No blockers — drop the ticket at the end of the project's backlog.
    // Mirrors the "end of backlog" semantics used by commitPlanAction's
    // baseOffset (read max column_position of project backlog + 1024).
    const { data: maxRow } = await supabase
      .from("tickets")
      .select("column_position")
      .eq("project_id", input.projectId)
      .eq("tenant_id", input.tenantId)
      .eq("status", "backlog")
      .order("column_position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const maxPos =
      maxRow && typeof maxRow.column_position === "number" ? maxRow.column_position : 0;
    return maxPos + 1024;
  }

  // Read column_position for each of the picked blockers (regardless of
  // status — a blocker may already be in_progress / in_review / done; we
  // still want the new ticket to live *after* it positionally on the
  // backlog).
  // Scoped even though `id` is a primary key and not an attacker-aimable
  // pointer: `blockerIds` is caller-supplied, so without this a hostile id would
  // let another tenant's `column_position` influence (and be inferred from) our
  // placement. A real blocker is in the same tenant, so nothing is lost.
  const { data: blockerRows } = await supabase
    .from("tickets")
    .select("column_position")
    .in("id", input.blockerIds)
    .eq("tenant_id", input.tenantId);
  let maxBlockerPos = 0;
  for (const r of blockerRows ?? []) {
    if (typeof r.column_position === "number" && r.column_position > maxBlockerPos) {
      maxBlockerPos = r.column_position;
    }
  }
  return maxBlockerPos + 1024;
}
