// Data loaders for the Run Inspector (/runs/[id]).
// Uses the RLS-bound server client so a user only sees runs in their tenant.

import { supabaseServer } from "@/lib/db/server";

export type RunStepKind =
  | "think"
  | "tool_call"
  | "tool_result"
  | "human_wait"
  | "system"
  // "Take the wheel" — a human-typed turn captured during an interactive
  // takeover session and mirrored into the run log.
  | "human";

export type RunStep = {
  id: number;
  runId: string;
  idx: number;
  kind: RunStepKind;
  payload: Record<string, unknown>;
  createdAt: string;
};

// `cancelled` is operator-initiated soft-cancel via Pause/Resume. Distinct
// from `failed` (exception or stale reaper) and `running` (in-flight). The
// drawer renders cancelled with a Resume button, same as failed.
export type RunHeader = {
  id: string;
  status: "running" | "awaiting_human" | "done" | "failed" | "cancelled";
  // Why the run is in its current status. For takeover the pause stamps
  // 'paused:takeover' here, which the Inspector reads to show "you have the
  // wheel" + a Release button instead of a generic cancelled state.
  statusReason: string | null;
  runnerKind: "api" | "local-cc" | null;
  budgetCents: number;
  spentCents: number;
  createdAt: string;
  lastEventAt: string;
  agentName: string | null;
  agentRole: string | null;
  ticketId: string | null;
  ticketTitle: string | null;
  // Phase 1 / M6 — sibling-cohort metadata. Present only when this run was
  // emitted as one of N parallel siblings by the dispatcher.
  fanOutGroup: string | null;
  fanOutRole: string | null;
  // Phase 1 / M13 — replay lineage. If this run is a replay clone, the id
  // of the original it replays. The Inspector uses this to render the
  // replay chain navigator (original → replay-1 → replay-2 …).
  replayOfRunId: string | null;
  // Track 2 — name of the tmux session the runner spawned `claude -p` inside
  // (e.g. `devpilot-run-<runId-16char>`). Populated for local-cc runs once the
  // runner stamps it via POST /api/runs/[id]/claim. Null for API-runner runs,
  // hosts without tmux, historical runs predating the column, or local-cc
  // runs whose tmux fallback path triggered (TmuxUnavailableError). The
  // Inspector uses presence as the "may be attachable" gate for the in-
  // browser terminal panel — absence simply hides the affordance.
  tmuxSessionName: string | null;
};

/**
 * Phase 1 / M13 — One node in the replay chain. The Inspector renders
 * `original → replay-1 → replay-2 …` for the chain that the current run
 * belongs to.
 */
export type ReplayChainNode = {
  id: string;
  status: RunHeader["status"];
  isOriginal: boolean;
  createdAt: string;
  /** True iff this node IS the run the inspector is currently rendering. */
  isCurrent: boolean;
};

/**
 * Sibling runs for a fan-out cohort, ordered by created_at. Excludes the run
 * whose page the Inspector is rendering — the caller already has that one
 * inline. The aggregator joins on `(tenant_id, fan_out_group)` so this is
 * the matching read-side projection for the Inspector header.
 */
export type RunSibling = {
  id: string;
  status: RunHeader["status"];
  fanOutRole: string | null;
  createdAt: string;
};

export type RunListItem = {
  id: string;
  status: RunHeader["status"];
  runnerKind: RunHeader["runnerKind"];
  spentCents: number;
  createdAt: string;
  agentRole: string | null;
  // Highest run_steps.idx where kind is a productive step
  // (think/tool_call/tool_result). Excludes system-audit steps so the drawer's
  // "Resume from step N" label points at a real checkpoint. -1 when the run
  // has produced nothing useful (e.g. cancelled before its first iteration).
  lastGoodStepIdx: number;
};

async function deriveRoleFromSteps(runId: string): Promise<string | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("run_steps")
    .select("payload")
    .eq("run_id", runId)
    .eq("kind", "think")
    .order("idx", { ascending: true })
    .limit(1);
  const first = data?.[0];
  const role = (first?.payload as { role?: string } | null)?.role;
  return role ?? null;
}

export async function loadRunHeader(runId: string): Promise<RunHeader | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("runs")
    .select(
      `
        id, status, status_reason, runner_kind, budget_cents, spent_cents, created_at, last_event_at,
        ticket_id, fan_out_group, fan_out_role, replay_of_run_id, tmux_session_name,
        agents ( name, role ),
        tickets!ticket_id ( title )
      `,
    )
    .eq("id", runId)
    .maybeSingle();
  if (error) {
    console.error(`[loadRunHeader] query failed for run ${runId}:`, error);
    return null;
  }
  if (!data) return null;

  const agent = Array.isArray(data.agents) ? data.agents[0] : data.agents;
  const ticket = Array.isArray(data.tickets) ? data.tickets[0] : data.tickets;
  const agentRole = (agent?.role as string | undefined) ?? (await deriveRoleFromSteps(runId));

  return {
    id: data.id as string,
    status: data.status as RunHeader["status"],
    statusReason: (data.status_reason as string | null) ?? null,
    runnerKind: (data.runner_kind ?? null) as RunHeader["runnerKind"],
    budgetCents: data.budget_cents as number,
    spentCents: data.spent_cents as number,
    createdAt: data.created_at as string,
    lastEventAt: data.last_event_at as string,
    agentName: (agent?.name as string | undefined) ?? null,
    agentRole,
    ticketId: (data.ticket_id as string | null) ?? null,
    ticketTitle: (ticket?.title as string | undefined) ?? null,
    fanOutGroup: (data.fan_out_group as string | null) ?? null,
    fanOutRole: (data.fan_out_role as string | null) ?? null,
    replayOfRunId: (data.replay_of_run_id as string | null) ?? null,
    tmuxSessionName: (data.tmux_session_name as string | null) ?? null,
  };
}

/**
 * Phase 1 / M13 — Compute the replay chain that `runId` belongs to.
 *
 * One round trip: the `replay_chain` SQL function (SECURITY INVOKER, so the
 * caller's RLS applies) climbs replay_of_run_id pointers to the chain's
 * original and returns original + every direct replay in created_at order.
 * See supabase/migrations/20260707000000_replay_chain_fn.sql.
 *
 * Returns an empty list when the chain has just the original (no replays
 * yet) so the Inspector hides the navigator strip on standalone runs.
 */
export async function loadReplayChain(runId: string): Promise<ReplayChainNode[]> {
  const supabase = await supabaseServer();

  type ChainRow = {
    id: string;
    status: string;
    replay_of_run_id: string | null;
    created_at: string;
  };
  const { data, error } = await supabase.rpc("replay_chain", { p_run_id: runId });
  if (error) {
    // Deploy-order safety net: if the function isn't in the database yet
    // (code deployed before `supabase db push`), fall back to the legacy
    // hop-by-hop walk so the Inspector keeps working. Delete once the
    // migration is applied everywhere.
    const functionMissing = error.code === "42883" || error.code === "PGRST202";
    console.warn(
      functionMissing
        ? `[loadReplayChain] replay_chain function missing (code ${error.code}); ` +
            "falling back to hop-by-hop walk. Apply migration 20260707000000_replay_chain_fn.sql."
        : `[loadReplayChain] replay_chain rpc failed (code ${error.code ?? "unknown"}): ` +
            `${error.message}; falling back to hop-by-hop walk.`,
    );
    return loadReplayChainByClimb(runId);
  }

  const nodes: ReplayChainNode[] = ((data ?? []) as ChainRow[]).map((r) => ({
    id: r.id,
    status: r.status as RunHeader["status"],
    isOriginal: r.replay_of_run_id === null,
    createdAt: r.created_at,
    isCurrent: r.id === runId,
  }));
  if (nodes.length <= 1) return [];
  return nodes;
}

/** Legacy pre-RPC replay-chain walk (≤ 8 sequential reads). Fallback only. */
async function loadReplayChainByClimb(runId: string): Promise<ReplayChainNode[]> {
  const supabase = await supabaseServer();

  // Climb to the original. We bound the walk at 8 hops because chains are
  // capped at DEVPILOT_MAX_REPLAYS_PER_RUN (default 5) and we never want a
  // malformed graph to spin the loop forever.
  let cursorId: string | null = runId;
  let originalId: string = runId;
  for (let hop = 0; hop < 8 && cursorId !== null; hop++) {
    const row: { id: string; replay_of_run_id: string | null } | null = (
      await supabase.from("runs").select("id, replay_of_run_id").eq("id", cursorId).maybeSingle()
    ).data as { id: string; replay_of_run_id: string | null } | null;
    if (!row) break;
    const parentId: string | null = row.replay_of_run_id;
    if (parentId === null) {
      originalId = row.id;
      break;
    }
    originalId = parentId;
    cursorId = parentId;
  }

  // Fetch original + all its direct replays in created_at order.
  const [originalRes, replaysRes] = await Promise.all([
    supabase.from("runs").select("id, status, created_at").eq("id", originalId).maybeSingle(),
    supabase
      .from("runs")
      .select("id, status, created_at")
      .eq("replay_of_run_id", originalId)
      .order("created_at", { ascending: true }),
  ]);

  const nodes: ReplayChainNode[] = [];
  if (originalRes.data) {
    nodes.push({
      id: originalRes.data.id as string,
      status: originalRes.data.status as RunHeader["status"],
      isOriginal: true,
      createdAt: originalRes.data.created_at as string,
      isCurrent: (originalRes.data.id as string) === runId,
    });
  }
  for (const r of replaysRes.data ?? []) {
    nodes.push({
      id: r.id as string,
      status: r.status as RunHeader["status"],
      isOriginal: false,
      createdAt: r.created_at as string,
      isCurrent: (r.id as string) === runId,
    });
  }
  if (nodes.length <= 1) return [];
  return nodes;
}

/**
 * Sibling-cohort projection for the Inspector's M6 fan-out branch view. The
 * Inspector renders one node per sibling so the operator can hop between
 * parallel runs without leaving the page.
 */
export async function loadRunSiblings(runId: string, fanOutGroup: string): Promise<RunSibling[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("runs")
    .select("id, status, fan_out_role, created_at")
    .eq("fan_out_group", fanOutGroup)
    .neq("id", runId)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    status: r.status as RunHeader["status"],
    fanOutRole: (r.fan_out_role as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export async function loadRunSteps(runId: string): Promise<RunStep[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("run_steps")
    .select("id, run_id, idx, kind, payload, created_at")
    .eq("run_id", runId)
    .order("idx", { ascending: true });
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as number,
    runId: r.run_id as string,
    idx: r.idx as number,
    kind: r.kind as RunStepKind,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    createdAt: r.created_at as string,
  }));
}

export async function loadRunsForTicket(ticketId: string): Promise<RunListItem[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("runs")
    .select(`id, status, runner_kind, spent_cents, created_at, agents ( role )`)
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error || !data) return [];

  // Backfill role from run_steps.payload for runs whose agent_id is null
  // (Phase 0 doesn't persist agent rows; role lives in the step payload).
  const needRole = data.filter((r) => {
    const agent = Array.isArray(r.agents) ? r.agents[0] : r.agents;
    return !agent?.role;
  });
  const rolesByRun = new Map<string, string>();
  if (needRole.length > 0) {
    const { data: steps } = await supabase
      .from("run_steps")
      .select("run_id, payload")
      .in(
        "run_id",
        needRole.map((r) => r.id),
      )
      .eq("kind", "think")
      .order("idx", { ascending: true });
    for (const s of steps ?? []) {
      const role = (s.payload as { role?: string } | null)?.role;
      if (role && !rolesByRun.has(s.run_id)) rolesByRun.set(s.run_id, role);
    }
  }

  // Compute lastGoodStepIdx per run for the drawer's "Resume from step N"
  // label. Excludes 'system' steps (audit markers at idx 99_993..99_999) and
  // 'human_wait' (a pause, not productive work). Single batched query —
  // could move to an RPC with `select run_id, max(idx) ... group by run_id`
  // if this becomes a hotspot on tickets with many long runs.
  const lastGoodByRun = new Map<string, number>();
  if (data.length > 0) {
    const { data: goodSteps } = await supabase
      .from("run_steps")
      .select("run_id, idx")
      .in(
        "run_id",
        data.map((r) => r.id),
      )
      .in("kind", ["think", "tool_call", "tool_result"]);
    for (const s of goodSteps ?? []) {
      const runId = s.run_id as string;
      const idx = s.idx as number;
      const cur = lastGoodByRun.get(runId);
      if (cur === undefined || idx > cur) lastGoodByRun.set(runId, idx);
    }
  }

  return data.map((r) => {
    const agent = Array.isArray(r.agents) ? r.agents[0] : r.agents;
    const role = (agent?.role as string | undefined) ?? rolesByRun.get(r.id) ?? null;
    return {
      id: r.id as string,
      status: r.status as RunHeader["status"],
      runnerKind: (r.runner_kind ?? null) as RunHeader["runnerKind"],
      spentCents: r.spent_cents as number,
      createdAt: r.created_at as string,
      agentRole: role,
      lastGoodStepIdx: lastGoodByRun.get(r.id) ?? -1,
    };
  });
}
