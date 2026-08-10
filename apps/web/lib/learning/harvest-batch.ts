// The DI'd harvest orchestration: load a ticket's runs / verifications / comments
// through an injected client, derive the mistakes (pure `deriveMistakes`), and
// upsert them into `agent_mistakes` (idempotent on the dedupe key).
//
// ── Why this file has no `server-only` (and why it's split from harvest.server.ts) ──
// Every IO dependency arrives as an argument (`HarvestDeps.db`), so this module
// can be unit-tested with a fake client — the same DI split ticket-audit.ts uses.
// `harvest.server.ts` is the thin twin that supplies the real service client +
// role resolver and carries the `server-only` marker. Tests import from HERE.
//
// One entry point drives BOTH harvest paths so they can never diverge:
//   • harvestTicketMistakes — called go-forward by the Inngest hook on
//     `agent/run.completed`, and per-ticket by the backfill.
//   • backfillTenantMistakes — iterates a tenant's tickets and harvests each.
//
// Security (load-bearing)
// ───────────────────────
// Reads run on the SERVICE client (RLS off), so tenant isolation is carried
// entirely by the `.eq("tenant_id", tenantId)` written into each query — the
// pattern `lib/metrics/project.ts` documents at length. `tenantId` is proved
// against the ticket row first, then threaded into every subsequent read AND the
// upsert. A row's own write policy never constrains the FK it points at, so an
// unscoped read of `runs`/`comments`/`run_verifications` keyed on a ticket id
// could return a foreign tenant's forged row; the predicate is what prevents it.
// `__tests__/harvest-tenant-scope.test.ts` proves a foreign row is never
// attributed. The `agent_mistakes` assert_tenant_matches_parent triggers are the
// second line of defence at write time.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveMistakes,
  type DerivedMistake,
  type HarvestComment,
  type HarvestRun,
  type HarvestVerification,
} from "@/lib/learning/harvest";

export type HarvestDeps = {
  db: SupabaseClient;
  /**
   * Resolve a producer's onSuccessStatus (`in_review` = producer, `done` =
   * reviewer) from its role slug + owning agent config. Injected so the flow is
   * testable without the role catalog.
   */
  resolveOnSuccessStatus: (role: string | null, agentConfig: unknown) => string | null;
};

export type HarvestResult =
  | { ok: true; derived: number; inserted: number }
  | { ok: false; reason: string };

/**
 * Harvest every mistake on one ticket and upsert them. Idempotent: re-running
 * over the same stored data re-derives the same rows with the same dedupe keys,
 * and the unique index drops the duplicates. Never throws — a harvest failure
 * must not fail the run that triggered it.
 */
export async function harvestTicketMistakes(
  deps: HarvestDeps,
  args: { tenantId: string; ticketId: string; dryRun?: boolean },
): Promise<HarvestResult> {
  const { tenantId, ticketId } = args;
  try {
    const { db } = deps;

    // Ticket — proves the tenant and supplies retry_count (the QA-reject count).
    const { data: ticketRow, error: ticketErr } = await db
      .from("tickets")
      .select("id, tenant_id, retry_count, status")
      .eq("id", ticketId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (ticketErr) return { ok: false, reason: `ticket-load:${ticketErr.message}` };
    if (!ticketRow) return { ok: false, reason: "ticket-not-found" };

    // Runs on the ticket. Tenant-scoped: runs.ticket_id is a nullable FK to ANY
    // ticket and the write policy pins only the run's own tenant, so a foreign
    // run could otherwise attach to our ticket.
    const { data: runRows, error: runErr } = await db
      .from("runs")
      .select("id, agent_id, fan_out_role, status, created_at, last_event_at")
      .eq("ticket_id", ticketId)
      .eq("tenant_id", tenantId);
    if (runErr) return { ok: false, reason: `runs-load:${runErr.message}` };
    const runsRaw = runRows ?? [];
    const runIds = runsRaw.map((r) => r.id as string);

    // Agents (for role + onSuccessStatus resolution), tenant-scoped.
    const agentIds = [...new Set(runsRaw.map((r) => r.agent_id).filter(Boolean) as string[])];
    const agentMap = new Map<string, { role: string | null; config: unknown }>();
    if (agentIds.length > 0) {
      const { data: agentRows } = await db
        .from("agents")
        .select("id, role, config")
        .in("id", agentIds)
        .eq("tenant_id", tenantId);
      for (const a of agentRows ?? []) {
        agentMap.set(a.id as string, { role: (a.role as string | null) ?? null, config: a.config });
      }
    }

    // Resolve each run's producer role + onSuccessStatus. COALESCE(fan_out_role,
    // agents.role) — the lib/metrics/project.ts attribution rule.
    const runs: HarvestRun[] = runsRaw.map((r) => {
      const agent = r.agent_id ? agentMap.get(r.agent_id as string) : undefined;
      const role = (r.fan_out_role as string | null) ?? agent?.role ?? null;
      return {
        runId: r.id as string,
        agentId: (r.agent_id as string | null) ?? null,
        role,
        onSuccessStatus: deps.resolveOnSuccessStatus(role, agent?.config ?? null),
        status: r.status as string,
        createdAt: r.created_at as string,
        lastEventAt: (r.last_event_at as string | null) ?? null,
      };
    });

    // Verifications for those runs (run_verifications is unique per run_id).
    let verifications: HarvestVerification[] = [];
    if (runIds.length > 0) {
      const { data: vRows } = await db
        .from("run_verifications")
        .select("run_id, command, exit_code, output_tail, ran_at")
        .in("run_id", runIds)
        .eq("tenant_id", tenantId);
      verifications = (vRows ?? []).map((v) => ({
        runId: v.run_id as string,
        command: (v.command as string) ?? "",
        exitCode: (v.exit_code as number) ?? 0,
        outputTail: (v.output_tail as string | null) ?? "",
        ranAt: v.ran_at as string,
      }));
    }

    // Comments on the ticket (gate/human/verdict signals), tenant-scoped.
    const { data: commentRows } = await db
      .from("comments")
      .select("id, author_type, author_id, body, created_at")
      .eq("ticket_id", ticketId)
      .eq("tenant_id", tenantId);
    const comments: HarvestComment[] = (commentRows ?? []).map((c) => ({
      id: c.id as string,
      authorType: c.author_type as string,
      authorId: (c.author_id as string | null) ?? "",
      body: (c.body as string | null) ?? "",
      createdAt: c.created_at as string,
    }));

    // Best-effort failure narrative for failed runs (last text step). run_steps
    // has no tenant_id — it is scoped by the run it belongs to.
    const failedRunIds = runs.filter((r) => r.status === "failed").map((r) => r.runId);
    if (failedRunIds.length > 0) {
      const { data: stepRows } = await db
        .from("run_steps")
        .select("run_id, idx, kind, payload")
        .in("run_id", failedRunIds)
        .in("kind", ["think", "system"])
        .order("idx", { ascending: false });
      const seen = new Set<string>();
      for (const s of stepRows ?? []) {
        const rid = s.run_id as string;
        if (seen.has(rid)) continue; // highest idx first → first seen is newest
        const text = (s.payload as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text.trim()) {
          seen.add(rid);
          const run = runs.find((r) => r.runId === rid);
          if (run) run.failureText = text.trim().slice(0, 2000);
        }
      }
    }

    const derived = deriveMistakes({
      ticket: {
        ticketId,
        tenantId,
        retryCount: (ticketRow.retry_count as number) ?? 0,
        status: ticketRow.status as string,
      },
      runs,
      verifications,
      comments,
    });

    if (derived.length === 0) return { ok: true, derived: 0, inserted: 0 };

    // Preview mode: derive but never write. The dedupe key is the same, so a real
    // run after a dry run records exactly what the preview reported.
    if (args.dryRun) return { ok: true, derived: derived.length, inserted: derived.length };

    const rows = derived.map((m) => toRow(m, tenantId, ticketId));
    // ignoreDuplicates: a re-harvest / go-forward re-fire / backfill overlap must
    // not error on the unique (tenant_id, dedupe_key) — it silently no-ops.
    const { error: upErr } = await db
      .from("agent_mistakes")
      .upsert(rows, { onConflict: "tenant_id,dedupe_key", ignoreDuplicates: true });
    if (upErr) return { ok: false, reason: `upsert:${upErr.message}` };

    return { ok: true, derived: derived.length, inserted: rows.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[learning-harvest] ticket=${ticketId} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

function toRow(m: DerivedMistake, tenantId: string, ticketId: string) {
  return {
    tenant_id: tenantId,
    agent_id: m.agentId,
    role: m.role,
    ticket_id: ticketId,
    run_id: m.runId,
    type: m.type,
    counts_against_score: m.countsAgainstScore,
    severity: m.severity,
    evidence: m.evidence,
    corrected_by: m.correctedBy,
    dedupe_key: m.dedupeKey,
  };
}

export type BackfillResult = {
  tenantId: string;
  ticketsScanned: number;
  ticketsWithMistakes: number;
  mistakesInserted: number;
  failures: number;
};

/**
 * One-time (re-runnable) backfill: harvest every ticket in a tenant. Idempotent
 * via the same dedupe key as the go-forward path, so running it twice — or after
 * go-forward already recorded some rows — records nothing new. Scoped per tenant,
 * service-role with the tenant PRE-VALIDATED by the caller (the CLI derives it
 * from a --tenant arg; there is no session here).
 */
export async function backfillTenantMistakes(
  deps: HarvestDeps,
  args: {
    tenantId: string;
    dryRun?: boolean;
    onProgress?: (scanned: number, total: number) => void;
  },
): Promise<BackfillResult> {
  const { tenantId } = args;
  const { data: ticketRows, error } = await deps.db
    .from("tickets")
    .select("id")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`backfill tickets-load: ${error.message}`);
  const ticketIds = (ticketRows ?? []).map((t) => t.id as string);

  const result: BackfillResult = {
    tenantId,
    ticketsScanned: 0,
    ticketsWithMistakes: 0,
    mistakesInserted: 0,
    failures: 0,
  };
  for (const ticketId of ticketIds) {
    const r = await harvestTicketMistakes(deps, { tenantId, ticketId, dryRun: args.dryRun });
    result.ticketsScanned += 1;
    if (r.ok) {
      if (r.inserted > 0) result.ticketsWithMistakes += 1;
      result.mistakesInserted += r.inserted;
    } else {
      result.failures += 1;
    }
    args.onProgress?.(result.ticketsScanned, ticketIds.length);
  }
  return result;
}
