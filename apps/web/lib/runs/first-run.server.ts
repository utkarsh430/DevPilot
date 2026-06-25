// A3 — first-dispatch detection for the activation nudge.
// Scoped to the caller's active tenant explicitly (RLS alone spans every
// tenant the user is a member of). Kept out of lib/runs/queries.ts on
// purpose: this is a one-off activation probe, not an inspector loader.

import { supabaseServer } from "@/lib/db/server";

export type FirstRunProbe =
  /** No runs yet — the caller may re-check when a ticket dispatches. */
  | { status: "pending" }
  /** Exactly one run exists and it's fresh: the tenant's first-ever dispatch. */
  | { status: "first"; runId: string }
  /** Existing run history (or a lone stale run) — never nudge. */
  | { status: "many" };

/** Run statuses where "your first agent is working" is still a true claim. */
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "awaiting_human"]);

/** A finished run this recent still reads as "just dispatched". */
const RECENT_RUN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Cheap probe: is the tenant's run history exactly one run long, and is that
 * run still worth nudging about (active, or created moments ago)? One indexed
 * select with `limit 2` — never a full count. Errors degrade to "many" so the
 * nudge silently stays away rather than throwing on the board.
 */
export async function probeFirstRun(tenantId: string): Promise<FirstRunProbe> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("runs")
    .select("id, status, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(2);
  if (error) return { status: "many" };
  const first = data?.[0];
  if (!first) return { status: "pending" };
  if (data.length !== 1) return { status: "many" };
  const createdAt = Date.parse(first.created_at as string);
  const isRecent = Number.isFinite(createdAt) && Date.now() - createdAt <= RECENT_RUN_WINDOW_MS;
  if (ACTIVE_RUN_STATUSES.has(first.status as string) || isRecent) {
    return { status: "first", runId: first.id as string };
  }
  return { status: "many" };
}
