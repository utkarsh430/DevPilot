"use server";

// WI-14 - the per-project opt-in for agent-filed tickets.
//
// Same shape and same reasoning as `setAutoLandEnabledAction` (integration-
// actions.ts) and the SME safety flag: the column decides whether the platform
// may create work on the operator's board without being asked, so ONLY an
// operator may write it. No agent, MCP tool, runner route, or engine path
// touches `projects.agent_ticket_creation` - which is what stops an agent from
// enabling its own ticket-filing tool.
//
// What the flag actually unlocks is narrow: `devpilot_create_ticket` files into
// `backlog` with no requested role. It cannot start a run, and it cannot reach
// `ready` on its own - a human moves it (or `promoteUnblockedDependents` does,
// itself a separate per-project opt-in). The blast radius of leaving this on is
// a noisier backlog, not spend.

import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { loadProjectById } from "@/lib/projects/load";
import { normalizeTicketCeiling } from "@/lib/board/agent-ticket";

export type SetAgentTicketCreationInput = { projectId: string; enabled: boolean };
export type SetAgentTicketCreationResult =
  | { ok: true; enabled: boolean }
  | { ok: false; error: string };

export async function setAgentTicketCreationAction(
  input: SetAgentTicketCreationInput,
): Promise<SetAgentTicketCreationResult> {
  await requireUser();
  const callerTenantId = await requireTenantId();

  const project = await loadProjectById(input.projectId);
  if (!project) return { ok: false, error: "Project not found." };
  if (project.tenantId !== callerTenantId) {
    return { ok: false, error: "Project does not belong to your tenant." };
  }

  const supabase = supabaseService();
  const { error } = await supabase
    .from("projects")
    .update({ agent_ticket_creation: input.enabled })
    .eq("id", project.id);
  if (error) return { ok: false, error: `Failed to save: ${error.message}` };

  revalidatePath(`/projects/${project.id}`);
  return { ok: true, enabled: input.enabled };
}

export type SetAgentTicketMaxPerRunInput = {
  projectId: string;
  /** NULL clears the override, returning the project to the inherited chain
   *  (`DEVPILOT_MAX_TICKETS_PER_RUN`, then the built-in default). It does NOT mean
   *  "no cap" - there is no value here that can disable the ceiling. */
  maxPerRun: number | null;
};
export type SetAgentTicketMaxPerRunResult =
  | { ok: true; maxPerRun: number | null }
  | { ok: false; error: string };

/**
 * The per-project rung of the ticket ceiling.
 *
 * Operator-gated exactly like the switch above, and for the same reason: no
 * agent, MCP tool, runner route or engine path may write this column, or an
 * agent at its cap could raise its own cap. `requireUser` + the tenant guard
 * are the whole boundary (the write is service-role, which bypasses RLS).
 *
 * A rejected value is REFUSED, never coerced. Silently rounding "0" up to 1 or
 * clamping garbage to the default would leave the operator looking at a number
 * they did not type and did not agree to, which for a safety ceiling is worse
 * than an error message.
 */
export async function setAgentTicketMaxPerRunAction(
  input: SetAgentTicketMaxPerRunInput,
): Promise<SetAgentTicketMaxPerRunResult> {
  await requireUser();
  const callerTenantId = await requireTenantId();

  const project = await loadProjectById(input.projectId);
  if (!project) return { ok: false, error: "Project not found." };
  if (project.tenantId !== callerTenantId) {
    return { ok: false, error: "Project does not belong to your tenant." };
  }

  // Same predicate the resolver uses, so what the form accepts and what the
  // route honours cannot drift. `null` is the one legitimate way to say
  // "inherit"; anything else that fails the predicate is an operator typo.
  let value: number | null = null;
  if (input.maxPerRun !== null) {
    value = normalizeTicketCeiling(input.maxPerRun);
    if (value === null) {
      return {
        ok: false,
        error: "Enter a whole number of 1 or more, or leave it blank to inherit the default.",
      };
    }
  }

  const supabase = supabaseService();
  const { error } = await supabase
    .from("projects")
    .update({ agent_ticket_max_per_run: value })
    .eq("id", project.id);
  if (error) return { ok: false, error: `Failed to save: ${error.message}` };

  revalidatePath(`/projects/${project.id}`);
  return { ok: true, maxPerRun: value };
}
