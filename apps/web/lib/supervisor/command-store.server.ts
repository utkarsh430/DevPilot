// Production wiring for the console's COMMAND deps.
//
// This is the ONLY file on the command path that touches a `server-only`
// module. Everything that decides anything - what may be commanded
// (`console-commands.ts`), what actually happens (`command-store.ts`) - is
// marker-free and therefore testable. Same split, same reasoning, as
// `console-store.server.ts` beside it.
//
// ── EVERY DEP IS AN EXISTING PRIMITIVE, CALLED AS THE ENGINE CALLS IT ─────
// Nothing here composes a new policy. `transitionTicket` is passed `actor:
// "human"` and its own gates run; `createTicketCore` is the shared insert path;
// the dependency trio is the same one `devpilot_create_ticket` uses, cycle guard
// included; the team path writes the dispatcher's own `cohort_plan` shape and
// then asks the dispatcher to run it.
//
// ── EVERY EMIT IS BOUNDED ─────────────────────────────────────────────────
// `inngest.send` has no timeout, and A HANG IS NOT AN ERROR: against a wedged
// event endpoint the promise never settles, so no `catch` runs and every
// statement after it is simply never executed. This is a REQUEST path - an
// operator clicked a button - and it runs exactly when that endpoint is most
// likely to be sick. Unlike the recovery wiring next door the error is NOT
// swallowed: here the emit IS the command (a dispatch that never left is a
// dispatch that did not happen), so it is reported.

import "server-only";

import { randomUUID } from "node:crypto";
import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { addComment, transitionTicket } from "@/lib/board/transitions";
import { createTicketCore } from "@/lib/board/create-ticket";
import { pauseTicket, resumeTicket } from "@/lib/engine/pause-resume";
import { countActiveRunsForTenant } from "@/lib/engine/spawning";
import { ROLES } from "@/lib/roles";
import { getBuiltinRoleConfig, loadCustomRoleConfig } from "@/lib/roles/load";
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";
import { loadOverlayForDispatch } from "@/lib/roles/overlay.server";
import {
  insertTicketDependencies,
  loadBlockingEdgeClosure,
  resolveDependencyRefs,
} from "@/lib/board/ticket-deps.server";
import { defaultConsoleDeps } from "@/lib/supervisor/console-store.server";
import type { CommandDeps } from "@/lib/supervisor/command-store";

/** A run started from the console has no run to inherit aliases from, and
 *  `parseDependencyList` refuses the alias form for exactly that reason - so
 *  this id is never consulted. Passed because the resolver's signature requires
 *  one; a nil uuid rather than a real-looking one so nothing can match it. */
const NO_RUN = "00000000-0000-0000-0000-000000000000";

export function defaultCommandDeps(nowIso: string): CommandDeps {
  const base = defaultConsoleDeps(nowIso);
  const db = supabaseService();

  return {
    ...base,

    loadDispatchableRoles: async (tenantId) => {
      // Exactly the set `decideNextRole` accepts as a `forceRole`: a built-in,
      // or a slug with an agents row for this tenant. Offering anything else
      // would produce a command the dispatcher silently drops back to the state
      // machine on - a button that appears to work and does something else.
      const builtins = Object.keys(ROLES);
      const { data, error } = await db
        .from("agents")
        .select("role")
        .eq("tenant_id", tenantId)
        .limit(500);
      if (error) return builtins;
      const custom = ((data ?? []) as Array<{ role: string | null }>)
        .map((r) => r.role)
        .filter((r): r is string => typeof r === "string" && r.length > 0);
      return [...new Set([...builtins, ...custom])];
    },

    countActiveRuns: async (tenantId) => {
      const counted = await countActiveRunsForTenant(tenantId);
      // NULL, never 0, when the count fails. Zero would read as "the tenant is
      // idle" and would make the console offer a team it may have no room for.
      return counted.ok ? counted.count : null;
    },

    emitDispatch: async ({ ticketId, tenantId, forceRole }) => {
      try {
        await sendEventBounded({
          name: "ticket/dispatch-needed",
          data: { ticketId, tenantId, ...(forceRole ? { forceRole } : {}) },
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    transition: async ({ ticketId, tenantId, to, expectedFrom }) => {
      // `actor: "human"` is the whole point and is hardcoded: the operator IS
      // the human, so the QA hand-off gate correctly does not apply, the
      // human-only reopen edges are legal, and the SME safety gate treats a
      // `→ done` here as the approval it is. An agent-authored actor is not
      // expressible on this path.
      const res = await transitionTicket({ ticketId, tenantId, to, actor: "human", expectedFrom });
      return {
        transitioned: res.transitioned,
        refusal: res.gateRefusal?.reason,
      };
    },

    comment: async (args) => {
      await addComment(args);
    },

    pauseTicket: async ({ ticketId, tenantId, byUserId }) => {
      const res = await pauseTicket({ ticketId, tenantId, reason: "user", byUserId });
      if (!res.ok) return { ok: false, error: res.error };
      // `alreadyAtState` means the conditional UPDATE matched nothing - the
      // ticket had already left a pausable state. Reported as "not paused"
      // rather than as a success, because the operator asked for something that
      // did not happen.
      if ("alreadyAtState" in res) return { ok: true, paused: false, cancelledRuns: 0 };
      return { ok: true, paused: true, cancelledRuns: res.cancelledRunIds.length };
    },

    resumeTicket: async ({ ticketId, tenantId }) => {
      const res = await resumeTicket({ ticketId, tenantId });
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },

    createTicket: async ({ tenantId, projectId, title, description, requestedRole }) => {
      // The ONE shared insert path. `status` is stated rather than defaulted:
      // a console-filed ticket lands in the BACKLOG, so it starts no run and
      // spends nothing until the operator promotes it.
      const res = await createTicketCore({
        tenantId,
        projectId,
        title,
        description,
        supabase: db,
        status: "backlog",
        requestedRole,
      });
      return res.ok
        ? { ok: true, ticketId: res.ticketId, ticketNumber: res.ticketNumber }
        : { ok: false, error: res.error };
    },

    resolveDependencyRefs: async ({ tenantId, projectId, refs }) => {
      const res = await resolveDependencyRefs({ tenantId, projectId, runId: NO_RUN, refs });
      return {
        blockers: res.blockers.map((b) => ({ ref: b.ref, ticketId: b.ticketId, status: b.status })),
        unresolved: res.unresolved,
      };
    },

    loadBlockingEdges: ({ tenantId, fromTicketIds }) =>
      loadBlockingEdgeClosure({ tenantId, fromTicketIds }),

    insertDependencies: (rows) => insertTicketDependencies(rows),

    armCohortPlan: async ({ ticketId, tenantId, plan, strategy }) => {
      // CAS on `fan_out_group IS NULL`. That column is the dispatcher's OWN
      // idempotency anchor for a cohort, so a ticket that has already fanned
      // out matches zero rows and is refused here rather than being armed with
      // a second plan the dispatcher would then decline - which would leave the
      // ticket carrying a team it never ran.
      const { data, error } = await db
        .from("tickets")
        .update({ cohort_plan: plan, acceptance_strategy: strategy })
        .eq("id", ticketId)
        .eq("tenant_id", tenantId)
        .is("fan_out_group", null)
        .is("cohort_plan", null)
        .select("id");
      if (error) return { ok: false, error: error.message };
      if (!data || data.length === 0) {
        return {
          ok: false,
          error:
            "this ticket already has a team on it (a cohort has been armed or has already run). " +
            "A second cohort would re-spawn siblings, which the dispatcher refuses outright",
        };
      }
      return { ok: true };
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    startGoalRun: async ({ tenantId, projectId: _projectId, role, goal, budgetCents }) => {
      // ONE root run, of a role the operator picked, with the goal as its
      // prompt. This is the supervisor spawn route's emit minus the parent
      // lineage - there is no parent, so there is nothing for `assertCanSpawn`
      // to check against here. It is not a hole: every SPECIALIST this lead
      // then spawns goes through `POST /api/runners/tools/spawn`, which calls
      // `assertCanSpawn` unmodified, so depth, per-parent fan-out, the tenant
      // run cap and budget headroom are all re-checked per child - and the
      // headroom they draw from is the ceiling set right here.
      //
      // KNOWN AND STATED RATHER THAN HIDDEN: `agent/run.requested` carries no
      // project field, and `run-agent` derives the project from the TICKET. A
      // goal run has no ticket, so it resolves no project and therefore gets
      // the TENANT's LLM provider/model rather than this project's. That is
      // exactly how the supervisor spawn route already behaves for its own
      // ticket-less children; closing it means adding a field to the event
      // schema every emitter shares, which is a wider change than this one.
      const roleConfig = getBuiltinRoleConfig(role) ?? (await loadCustomRoleConfig(tenantId, role));
      if (!roleConfig) return { ok: false, error: `unknown role: ${role}` };

      const runId = randomUUID();
      const overlay = await loadOverlayForDispatch(tenantId, role);
      try {
        await sendEventBounded({
          name: "agent/run.requested",
          data: {
            runId,
            tenantId,
            prompt: goal,
            // `hasTicket: false` - there is no ticket, so the reviewer-awareness
            // note would promise a QA review that cannot happen. Same call the
            // supervisor spawn route makes, for the same reason.
            systemPrompt: composeRoleSystemPrompt(roleConfig, [], false, overlay),
            iterations: 1,
            modelTier: roleConfig.modelTier,
            runnerPolicy: roleConfig.runnerPolicy,
            budgetCents,
            role,
            agentDisplayName: roleConfig.displayName,
          },
        });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      return { ok: true, runId };
    },
  };
}
