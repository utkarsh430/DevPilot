// Automation pause/resume — single source of truth.
//
// Two layers of switch (workspace + project) collapse into one "effective"
// state. Every emit point on the hot path (dispatcher, schedule cron, WIP
// drain, replay surfaces, resumeTicket) consults this helper before
// emitting work.
//
// Semantics
// ─────────
// • Pause means "stop spawning new work" AND "halt in-flight runs at their
//   next iteration boundary." The current `claude -p` step lands (never
//   hard-killed mid-step), then the run loop's check-cancel step reads this
//   pause state and exits cleanly, flipping its run to 'cancelled'
//   (status_reason 'paused:automation:<scope>'). Tickets stay in whatever
//   state they were in — a board pause never moves a ticket to the paused
//   column (that's the per-ticket primitive in pause-resume.ts). Resume
//   re-dispatches the halted ticket (fresh from its last checkpoint) via
//   emitResumeDispatches. The halt decision is the pure `decideCancelCheck`
//   (lib/engine/cancel-check-policy.ts).
// • Either tenant.automation_state OR project.automation_state being
//   'paused' suppresses work for that project. Tenant is the master kill;
//   project is the per-project override. When the tenant is paused, the
//   project-level switch is informationally redundant but not destructive.
//
// Schema
// ──────
// See 20260609020000_automation_pause.sql. Columns on both tables:
//   automation_state            text NOT NULL ('running'|'paused')
//   automation_paused_at        timestamptz
//   automation_resumed_at       timestamptz
//   automation_paused_by_user_id uuid
//
// Why a helper, not inline queries
// ────────────────────────────────
// Every emit point would otherwise re-implement the AND/OR logic. Centralising
// it here means a future "scheduled-pause window" or "pause expires at T"
// behavior plugs in one place. The hot path is two indexed-id lookups; cache
// per Inngest-step if you call it more than once in a single function.

import { supabaseService } from "@/lib/db/server";

export type EffectivePause =
  | { paused: false }
  | {
      paused: true;
      /** Which layer flipped: 'tenant' (workspace master) wins if both. */
      scope: "tenant" | "project";
      /** Wallclock from the *winning* scope's automation_paused_at. */
      pausedAt: string | null;
      /** Soft reference to who flipped it, if recorded. */
      pausedByUserId: string | null;
    };

/**
 * Read the live pause state for (tenant, project?). Tenant is checked first
 * — a paused tenant short-circuits the project lookup entirely so the master
 * kill is always cheap.
 *
 * Missing rows (deleted tenant / no project context) return `{paused: false}`
 * — we trust callers to validate identity at their own layer; this helper's
 * only job is the pause flag.
 */
export async function getEffectivePause(
  tenantId: string,
  projectId?: string | null,
): Promise<EffectivePause> {
  const supabase = supabaseService();

  const { data: tenant, error: tErr } = await supabase
    .from("tenants")
    .select("automation_state, automation_paused_at, automation_paused_by_user_id")
    .eq("id", tenantId)
    .maybeSingle();
  if (tErr) {
    // Fail open — better to emit a dispatch than to stall the whole engine on
    // a transient lookup error. The dispatcher already swallows lookup
    // failures elsewhere (see checkWipLimit's fail-open comment).
    console.warn(
      `[automation-state] tenant lookup failed for ${tenantId}: ${tErr.message} — assuming running`,
    );
    return { paused: false };
  }
  if (tenant?.automation_state === "paused") {
    return {
      paused: true,
      scope: "tenant",
      pausedAt: (tenant.automation_paused_at as string | null) ?? null,
      pausedByUserId: (tenant.automation_paused_by_user_id as string | null) ?? null,
    };
  }

  if (!projectId) return { paused: false };

  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("automation_state, automation_paused_at, automation_paused_by_user_id")
    .eq("id", projectId)
    .maybeSingle();
  if (pErr) {
    console.warn(
      `[automation-state] project lookup failed for ${projectId}: ${pErr.message} — assuming running`,
    );
    return { paused: false };
  }
  if (project?.automation_state === "paused") {
    return {
      paused: true,
      scope: "project",
      pausedAt: (project.automation_paused_at as string | null) ?? null,
      pausedByUserId: (project.automation_paused_by_user_id as string | null) ?? null,
    };
  }

  return { paused: false };
}

/**
 * Convenience for code paths that have a ticket id but no project id
 * threaded through. Looks the project up off the ticket row first. Returns
 * `{paused: false}` if the ticket can't be located.
 */
export async function getEffectivePauseForTicket(
  tenantId: string,
  ticketId: string,
): Promise<EffectivePause> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("project_id")
    .eq("id", ticketId)
    .maybeSingle();
  if (error || !data) return getEffectivePause(tenantId, null);
  return getEffectivePause(tenantId, (data.project_id as string | null) ?? null);
}

/**
 * Structured error code used by surfaces that REFUSE rather than skip-silently
 * when paused (replay route, resumeTicket). Server actions / API routes turn
 * this into a 409 the UI can render as a clean toast.
 */
export const AUTOMATION_PAUSED_CODE = "automation-paused" as const;

export function pauseRefusalMessage(p: Exclude<EffectivePause, { paused: false }>): string {
  return p.scope === "tenant"
    ? "Workspace automation is paused — un-pause from the top nav to continue."
    : "Project automation is paused — un-pause from the project header to continue.";
}
