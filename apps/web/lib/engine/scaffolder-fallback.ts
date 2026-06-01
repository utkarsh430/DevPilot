// The held-scaffolder abandonment fallback.
//
// Why this exists
// ───────────────
// The "Create new repo" flow creates a genuinely EMPTY GitHub repo (`auto_init:
// false`), so its `project_scaffolder` ticket is not a nicety - it is the only
// thing that ever puts a commit in there. When the operator asks for a plan we
// HOLD that ticket in `backlog` so the plan's discussion can inform it, and
// `commitPlanAction` releases it. But a plan is a conversation, and a
// conversation can just… stop: the operator closes the tab, the session sits at
// `discussing` forever, and the release never fires.
//
// This function is what keeps "an empty project never stays empty" true in that
// case. It sleeps out the hold TTL and then releases the ticket with BASE
// context (name + description) - exactly what a plain no-plan create's
// scaffolder runs with. No plan was committed, so there IS no confirmed context
// to carry; a scaffold seeded from the description is the honest outcome and is
// strictly better than an empty repo.
//
// Idempotence is not a nice-to-have here, it is the whole correctness argument:
// this function and `commitPlanAction` (and `discardPlanSessionAction`) race by
// design - an operator can commit a plan the instant the TTL fires. All of them
// go through `releaseScaffolder`, whose claim lives in the UPDATE's WHERE clause
// - so the loser claims no row, dispatches nothing, and returns a no-op. It also
// never INSERTS: the create action is the only creator of a scaffolder row (the
// #79 invariant).
//
// IDENTITY, not shape. The claim is `plan_hold = true`, which names the exact
// instance this function was armed for, and the release clears it forever. That
// is what makes this safe to fire an hour and a half late into a board whose
// state has moved on: a scaffolder that was released and then legitimately reset
// to Backlog (a "Discard & restart from dev", a human reset) wears the same
// `backlog` + `project_scaffolder` shape as a held row, and keying on that shape
// would re-release and re-dispatch a ticket the operator had just deliberately
// parked. It cannot: its hold is long since cleared.
//
// See the runbook: docs/runbooks/add-inngest-function.md.

import { inngest } from "@/lib/engine/inngest";
import { resolveScaffolderHoldTtlMinutes } from "@/lib/plan/scaffolder";
import { releaseScaffolder } from "@/lib/plan/scaffolder-release.server";

export type ScaffolderFallbackResult =
  | { ok: true; released: true; ticketId: string }
  | { ok: true; released: false; reason: string };

/**
 * Release a still-held scaffolder, or no-op if something already did.
 *
 * `planSessionId: null` is the point of the whole function - see the module
 * docblock. Never throws: a failure to release is surfaced as `{released:
 * false, reason}` so an expected no-op ("not-held", the common case on a
 * committed plan) does not paint the Inngest dashboard red.
 */
export async function releaseHeldScaffolder(args: {
  ticketId: string;
  tenantId: string;
}): Promise<ScaffolderFallbackResult> {
  try {
    const result = await releaseScaffolder({
      tenantId: args.tenantId,
      ticketId: args.ticketId,
      planSessionId: null,
      via: "fallback",
    });
    if (result.released) return { ok: true, released: true, ticketId: result.ticketId };
    return { ok: true, released: false, reason: result.reason };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[scaffolder-fallback] ticket=${args.ticketId} failed: ${msg.slice(0, 200)}`);
    return { ok: true, released: false, reason: msg.slice(0, 200) };
  }
}

// Inngest entry point. `createProjectWithNewRepoAction` emits
// `project/scaffolder-held` when it files a HELD scaffolder.
//
// `step.sleep` is why this is a durable function rather than a setTimeout: the
// TTL is measured in tens of minutes and must survive a deploy, a restart, and
// a crash. A timer held in a web process's memory does not, and the one thing
// this function must not do is forget.
//
// retries: 2 - the work is a single guarded UPDATE + a send; a transient DB
// blip deserves a retry, and a retry after a SUCCESSFUL release is harmless
// (the claim no longer matches → "not-held" → no second dispatch).
export const scaffolderFallbackFn = inngest.createFunction(
  { id: "scaffolder-hold-fallback", retries: 2 },
  { event: "project/scaffolder-held" },
  async ({ event, step }) => {
    const { ticketId, tenantId } = event.data;
    const ttlMinutes = resolveScaffolderHoldTtlMinutes(
      process.env.DEVPILOT_SCAFFOLDER_HOLD_TTL_MINUTES,
    );

    await step.sleep("await-plan-commit", `${ttlMinutes}m`);

    return await step.run("release-if-still-held", async () =>
      releaseHeldScaffolder({ ticketId, tenantId }),
    );
  },
);
