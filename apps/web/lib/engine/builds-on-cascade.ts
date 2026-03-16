// Phase 2.5+ / Slice IB-C — builds_on cascade notifier.
//
// When a parent ticket lands on the integration branch (push succeeds), any
// ticket that declared `builds_on <parent>` is now eligible to push too —
// its `devpilot/<slug>` branch sits on top of the parent's work, and the
// Phase B pre-push rebase block will naturally fold parent commits when
// the operator pushes the child (git rebase replays only the child's own
// commits onto the new integration tip).
//
// What this function adds: a notification + audit trail per child so the
// operator + downstream automation can see the chain. We post a system
// comment on each child ticket and write a `merge_conflict_events`-style
// breadcrumb when the child has a pending_push.
//
// Important: we do NOT trigger an automatic re-rebase here. The runner
// owns the workspace, and re-running `git rebase` from outside the
// runner's lifecycle is racy. The next manual push of the child will
// rebase on the now-current integration tip, which is the right
// behaviour. The notifier is the audit + UX layer on top.

import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { loadBuildsOnChildren } from "@/lib/board/dependencies";
import { addComment } from "@/lib/board/transitions";

type ParentLandedData = {
  ticketId: string;
  tenantId: string;
  /** SHA the parent landed on the integration tip (if known). Optional —
   *  the notifier only uses it for the system-comment text. */
  integrationSha?: string | null;
  /** Integration branch name; surfaces in the system comment so the
   *  operator can confirm where the parent ended up. */
  integrationBranch?: string | null;
};

export const buildsOnParentLanded = inngest.createFunction(
  {
    id: "builds-on-parent-landed",
    retries: 1,
    concurrency: { limit: 4, key: "event.data.tenantId" },
  },
  { event: "branch/parent-landed" },
  async ({ event, step }) => {
    const { ticketId, tenantId, integrationSha, integrationBranch } =
      event.data as ParentLandedData;
    if (!ticketId || !tenantId) {
      throw new NonRetriableError("branch/parent-landed: ticketId + tenantId required");
    }

    const children = await step.run("load-builds-on-children", async () =>
      loadBuildsOnChildren(ticketId),
    );

    if (children.length === 0) {
      // Nothing to do — the landed ticket has no stacked children. Common
      // case for non-stacked work; fast-skip.
      return { ok: true, notified: 0 };
    }

    // For each child still in an active state, post a system comment +
    // log a synthetic merge_conflict_event tied to the child's most-recent
    // pending_push (when one exists). The comment makes the cascade
    // visible to the operator viewing the child's ticket drawer.
    const activeStatuses = new Set([
      "assigned",
      "in_progress",
      "in_review",
      "ready",
      "input_required",
    ]);
    let notified = 0;
    for (const child of children) {
      if (!activeStatuses.has(child.status)) continue;

      const baseText = integrationBranch
        ? `landed on \`${integrationBranch}\``
        : "landed on the integration branch";
      const shaText = integrationSha ? ` (sha \`${integrationSha.slice(0, 7)}\`)` : "";
      const body =
        `**Parent ticket landed.** The work this ticket builds on ${baseText}${shaText}. ` +
        `On the next push, the pre-push rebase will replay this ticket's own commits ` +
        `onto the new integration tip. No action required unless the rebase surfaces conflicts.`;

      await step.run(`comment-${child.id}`, async () => {
        try {
          await addComment({
            ticketId: child.id,
            tenantId,
            authorType: "system",
            authorId: "builds_on_cascade",
            body,
          });
        } catch (err) {
          console.warn(
            `[builds-on-cascade] addComment failed for child ${child.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      });

      // If the child has a pending_push, drop a breadcrumb into
      // merge_conflict_events so the /changes Conflicts tab timeline picks
      // it up. Best-effort — a missing pending_push is the common case
      // (the child hasn't produced one yet).
      await step.run(`audit-${child.id}`, async () => {
        const supabase = supabaseService();
        // Tenant-scoped to the CASCADE's tenant (from the event), not to
        // `pp.tenant_id` read back off whatever row came out — a row must not
        // authorise its own read. The breadcrumb below is inserted with this
        // row's tenant/project, so an unscoped read would write a
        // merge_conflict_events row into another tenant's timeline.
        const { data: pp } = await supabase
          .from("pending_pushes")
          .select("id, project_id, tenant_id")
          .eq("ticket_id", child.id)
          .eq("tenant_id", tenantId)
          .is("pushed_at", null)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!pp) return;
        await supabase.from("merge_conflict_events").insert({
          tenant_id: pp.tenant_id,
          project_id: pp.project_id,
          pending_push_id: pp.id,
          ticket_id: child.id,
          kind: "retry_pushed",
          payload: {
            parent_ticket_id: ticketId,
            parent_landed_on: integrationBranch ?? null,
            parent_sha: integrationSha ?? null,
            note: "Parent landed; child eligible to rebase on next push.",
          },
        });
      });

      notified++;
    }

    return { ok: true, notified };
  },
);
