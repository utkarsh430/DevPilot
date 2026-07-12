"use server";

// The per-project opt-in for the runner-resident project supervisor.
//
// Same shape and same reasoning as `setAgentTicketCreationAction` beside it and
// `setAutoLandEnabledAction`: this column decides whether the platform may move
// tickets on the operator's board without being asked, so ONLY an operator may
// write it. No agent, MCP tool, runner route or engine path touches
// `projects.supervisor_enabled` - which is what stops the supervisor arming
// itself, and what stops a compromised runner arming it either. The supervision
// route reads the column; nothing anywhere writes it but this function.
//
// What the flag unlocks is narrow, and it is worth being precise because the
// blast radius reads larger than it is. The supervisor can do exactly two
// things, both of which the engine's own crons already do on a healthy board:
// release a `dispatch_queue` row for an agent that provably has free capacity,
// and move a stalled ticket to `input_required` / `blocked` with an explanatory
// comment. It cannot start a run, cannot approve anything, cannot reach `done`,
// and cannot raise the WIP limit or any budget ceiling. And it does none of it
// at all while the engine's own Inngest crons are executing - see
// `lib/engine/supervisor-policy.ts` for why remediation is gated on that.
//
// DETECTION is never gated by this flag. An un-opted-in project's deadlock is
// still reported in the system-health surface; only ACTION requires consent.

import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { loadProjectById } from "@/lib/projects/load";

export type SetSupervisorEnabledInput = { projectId: string; enabled: boolean };
export type SetSupervisorEnabledResult =
  | { ok: true; enabled: boolean }
  | { ok: false; error: string };

export async function setSupervisorEnabledAction(
  input: SetSupervisorEnabledInput,
): Promise<SetSupervisorEnabledResult> {
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
    .update({ supervisor_enabled: input.enabled })
    .eq("id", project.id);
  if (error) return { ok: false, error: `Failed to save: ${error.message}` };

  revalidatePath(`/projects/${project.id}`);
  return { ok: true, enabled: input.enabled };
}
