"use server";

// The per-project escape hatch from the PER-RUN budget ceiling.
//
// Same shape and same reasoning as `setSupervisorEnabledAction` beside it:
// this column decides whether the platform may let a ticket's runs keep
// spending past `runs.budget_cents`, so ONLY an operator may write it. No
// agent, MCP tool, runner route or engine path touches
// `projects.budget_cap_override_enabled` — which is what stops a run arming
// its own escape hatch, and what stops a compromised runner arming it either.
// `run-agent.ts` reads the column (via `loadProjectForTicket`); nothing
// anywhere writes it but this function.
//
// What the flag does NOT unlock: the tenant-wide cost-velocity circuit
// breaker (`budget.ts`) is never bypassed by it. "Ignore my cap" never means
// "no ceiling at all" — see `lib/engine/budget-ceiling-policy.ts`.

import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { loadProjectById } from "@/lib/projects/load";

export type SetBudgetCapOverrideInput = { projectId: string; enabled: boolean };
export type SetBudgetCapOverrideResult =
  | { ok: true; enabled: boolean }
  | { ok: false; error: string };

export async function setBudgetCapOverrideAction(
  input: SetBudgetCapOverrideInput,
): Promise<SetBudgetCapOverrideResult> {
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
    .update({ budget_cap_override_enabled: input.enabled })
    .eq("id", project.id);
  if (error) return { ok: false, error: `Failed to save: ${error.message}` };

  revalidatePath(`/projects/${project.id}`);
  return { ok: true, enabled: input.enabled };
}
