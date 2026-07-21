// Phase 2.5++ / Scheduler — durable backlog drain + every-minute cron.
//
// Two Inngest functions:
//
//   • drainBacklogFn       — given (projectId), loads backlog tickets ordered
//                            by column_position and drains them through a
//                            SLIDING WINDOW of up to `drainParallelism`
//                            tickets (default 3): move that many
//                            dependency-eligible heads to `ready`, poll the
//                            in-flight set, and top the window back up as each
//                            one settles. Continues on failure so one stuck
//                            ticket doesn't halt the drain. Records a system
//                            comment per ticket for the audit trail. Updates
//                            ticket_schedules.current_drain_run_id while
//                            running so the UI can show a "draining…" chip.
//                            All window decisions are pure - see
//                            `lib/engine/drain-window.ts`.
//
//   • ticketScheduleCronFn — every-minute tick. Reads active recurring
//                            schedules whose (today's UTC weekday IS IN
//                            days_of_week) AND (HH:MM matches now's UTC
//                            HH:MM) AND (last_fired_at < today's 00:00 UTC).
//                            For each match, emits ticket-drain/requested
//                            and bumps last_fired_at. Also fires once-mode
//                            rows where run_at <= now() AND last_fired_at IS
//                            NULL, then flips them to status='completed'.
//
// Failure model: drain doesn't halt the loop on a single failed ticket. The
// status check polls every 30s and caps each ticket at 4 hours (240 sleeps).
// The whole drain caps at 50 tickets so a runaway schedule can't burn
// indefinite cron budget. Both bounds are operator-tunable via env if needed.

import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { transitionTicket, addComment, BlockedByDependencyError } from "@/lib/board/transitions";
import { loadBlockerSummaryService } from "@/lib/board/dependencies";
import type { TicketStatus } from "@/lib/board/state";
import { getEffectivePause } from "@/lib/engine/automation-state";
import { recordScheduleActivity } from "@/lib/schedules/activity";
import {
  resolveDrainParallelism,
  runDrainWindow,
  type DrainProbe,
} from "@/lib/engine/drain-window";

// Cron HH:MM match window. The Inngest cron tick can fire a few seconds
// late; with the old exact-minute match, a delay of >30s would push the
// wallclock to the next minute and silently skip the day. This window
// widens the match so any cron tick that fires "within the last N minutes
// of the schedule's HH:MM" counts as a hit. The CAS + last_fired_at gate
// still protects against double-fire across ticks.
const SCHEDULE_MATCH_WINDOW_MINUTES = Number(
  process.env.DEVPILOT_SCHEDULE_MATCH_WINDOW_MINUTES ?? "5",
);

const MAX_TICKETS_PER_DRAIN = 50;
const POLL_INTERVAL_SECONDS = 30;
const PER_TICKET_TIMEOUT_MINUTES = 240; // 4 hours
const MAX_POLLS_PER_TICKET = Math.ceil((PER_TICKET_TIMEOUT_MINUTES * 60) / POLL_INTERVAL_SECONDS);

export const drainBacklogFn = inngest.createFunction(
  {
    id: "drain-backlog",
    // One drain COORDINATOR per (tenant, project) at a time - if a second drain
    // fires while one is in flight, Inngest serialises them with this key. This
    // is deliberately still 1: the fan-out lives INSIDE the coordinator (the
    // sliding window below), not in a second competing drain that would
    // double-claim the same backlog snapshot.
    concurrency: {
      limit: 1,
      key: 'event.data.tenantId + "_" + event.data.projectId',
    },
    retries: 0, // We handle "continue on failure" inside the loop.
  },
  { event: "ticket-drain/requested" },
  async ({ event, step }) => {
    const { tenantId, projectId, scheduleId, drainParallelism } = event.data;
    // Window size, clamped to [1, MAX]. 1 = strictly serial (legacy behaviour);
    // absent = DEFAULT_DRAIN_PARALLELISM. The DB CHECK on ticket_schedules also
    // caps at 10; this is a belt for ad-hoc drains that bypass the table.
    const parallelism = resolveDrainParallelism(drainParallelism);

    // 1. Mark the schedule as "running" (current_drain_run_id = this run).
    //    Inngest provides the function run id via env.RUN_ID at execution
    //    time, but the cleanest is to mint our own opaque id. Minted INSIDE a
    //    step so it's memoised: derived at the top of the handler it would be
    //    re-rolled on every replay, and the activity rows written after a
    //    replay would carry a different drain id than `current_drain_run_id`.
    const drainId = await step.run(
      "mint-drain-id",
      async () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    if (scheduleId) {
      await step.run("mark-schedule-running", async () => {
        const svc = supabaseService();
        await svc
          .from("ticket_schedules")
          .update({ current_drain_run_id: drainId })
          .eq("id", scheduleId)
          .eq("tenant_id", tenantId);
      });
    }

    // 2. Load backlog tickets in column_position order. We snapshot ONCE at
    //    drain start — if the operator adds new tickets mid-drain, they wait
    //    for the next drain. (Simpler reasoning + bounds the loop length.)
    const ticketIds = await step.run("load-backlog", async () => {
      const svc = supabaseService();
      const { data, error } = await svc
        .from("tickets")
        .select("id, column_position")
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
        .eq("status", "backlog")
        .order("column_position", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(MAX_TICKETS_PER_DRAIN);
      if (error) {
        throw new NonRetriableError(`load-backlog failed: ${error.message}`);
      }
      return (data ?? []).map((r) => r.id as string);
    });

    if (ticketIds.length === 0) {
      // Nothing to do. Still mark the schedule completed if this was the
      // shot for the day.
      if (scheduleId) {
        await step.run("clear-empty", async () => {
          const svc = supabaseService();
          await svc
            .from("ticket_schedules")
            .update({ current_drain_run_id: null })
            .eq("id", scheduleId)
            .eq("tenant_id", tenantId);
        });
        await step.run("activity-empty", () =>
          recordScheduleActivity({
            tenantId,
            scheduleId,
            projectId,
            drainRunId: drainId,
            kind: "completed",
            reason: "empty-backlog",
            metadata: { drained: 0 },
          }),
        );
      }
      return { drained: 0, drainId };
    }

    // 3. Drain through a sliding window: keep up to `parallelism` tickets in
    //    flight, and top the window back up from the next dependency-ELIGIBLE
    //    backlog head each time one settles. Backlog order (column_position)
    //    decides who gets the next free slot; it is no longer a serialisation.
    //
    //    The loop and every window decision are pure and unit-tested
    //    (`lib/engine/drain-window.ts`); what lives here is only the IO. Each
    //    effect is a durable step keyed on a deterministic id (the ticket's
    //    1-based backlog slot, or the fill/poll round), so a replay after a
    //    crash re-derives the exact same window from memoised step results.
    const commentAuthorId = scheduleId ? `schedule:${scheduleId.slice(0, 8)}` : "schedule:adhoc";
    const slotOf = new Map(ticketIds.map((id, idx) => [id, idx + 1] as const));
    const slot = (ticketId: string) => slotOf.get(ticketId) ?? 0;

    const comment = async (stepId: string, ticketId: string, body: string) => {
      await step.run(stepId, async () => {
        try {
          await addComment({
            ticketId,
            tenantId,
            authorType: "system",
            authorId: commentAuthorId,
            body,
          });
        } catch (err) {
          // Best-effort comment — never block the drain on it.
          console.warn(
            `[drain] ${stepId} failed for ticket=${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    };

    const summary = await runDrainWindow({
      ticketIds,
      parallelism,
      maxPolls: MAX_POLLS_PER_TICKET,
      io: {
        // Is the ticket still in backlog (the operator may have moved it since
        // the snapshot), and is it dependency-eligible? Re-probed each fill
        // round because a blocker finishing - in this drain or outside it -
        // makes a deferred ticket eligible.
        probe: (pending, fillRound) =>
          step.run(`probe-${fillRound}`, async () => {
            const svc = supabaseService();
            const { data } = await svc
              .from("tickets")
              .select("id, status")
              .in("id", pending as string[]);
            const statusById = new Map(
              (data ?? []).map((r) => [r.id as string, r.status as TicketStatus]),
            );
            const entries = await Promise.all(
              pending.map(async (id) => {
                const status = statusById.get(id) ?? null;
                // Only a backlog row can be started, so only it needs the
                // (per-ticket) blocker read. WI-5: the summary distinguishes a
                // blocker that is still being WORKED from one that is done and
                // merely awaiting its landing - `planFill` forces the former (it
                // can never unblock on its own) and DEFERS the latter (the land
                // worker is about to unblock it, and forcing it would drop the
                // ticket to `stuck` seconds before it became startable).
                const summary =
                  status === "backlog"
                    ? (await loadBlockerSummaryService(id, tenantId)).summary
                    : { open: 0, working: 0, awaitingLand: 0, onlyAwaitingLand: false };
                return [
                  id,
                  {
                    status,
                    hasOpenBlockers: summary.open > 0,
                    onlyAwaitingLand: summary.onlyAwaitingLand,
                  } satisfies DrainProbe,
                ] as const;
              }),
            );
            return Object.fromEntries(entries) as Record<string, DrainProbe>;
          }),

        start: async (ticketId) => {
          await comment(
            `pre-comment-${slot(ticketId)}`,
            ticketId,
            `Drained from backlog (ticket ${slot(ticketId)}/${ticketIds.length}, up to ${parallelism} in flight).`,
          );
          // `transitionTicket` is the AUTHORITATIVE eligibility check - the
          // probe above only orders candidates, this is what actually refuses a
          // ticket whose blocker is still open (BlockedByDependencyError →
          // recorded `stuck`, exactly as the serial drain did).
          return step.run(`move-${slot(ticketId)}`, async () => {
            try {
              await transitionTicket({ ticketId, tenantId, to: "ready", actor: "system" });
              return { ok: true } as const;
            } catch (err) {
              if (err instanceof BlockedByDependencyError) {
                return { ok: false, blocked: true, error: err.message } as const;
              }
              return {
                ok: false,
                blocked: false,
                error: err instanceof Error ? err.message : String(err),
              } as const;
            }
          });
        },

        onSkipped: async () => {
          // Ticket left backlog on its own - nothing to say, nothing to undo.
        },

        onStartFailed: (ticketId, result) =>
          comment(
            `start-failed-comment-${slot(ticketId)}`,
            ticketId,
            result.blocked
              ? `Drain skipped this ticket - it still has an open blocker. It drains once the blocker is done.`
              : `Drain couldn't start this ticket: ${result.error}`,
          ),

        onSettled: async (ticketId, finalStatus, outcome) => {
          await comment(
            `post-comment-${slot(ticketId)}`,
            ticketId,
            outcome === "done"
              ? `Drain advanced — ticket completed.`
              : outcome === "failed"
                ? `Drain advanced - ticket failed; the drain continues with the rest of the backlog.`
                : outcome === "stuck"
                  ? `Drain released this slot (status ${finalStatus}); the drain continues with the rest of the backlog.`
                  : `Drain timed out after ${PER_TICKET_TIMEOUT_MINUTES} min waiting for terminal status; the drain continues with the rest of the backlog.`,
          );

          // Activity row - one per ticket advance. Only useful when the drain
          // belongs to a schedule; ad-hoc "Run now" drains have no schedule_id
          // and skip the log.
          if (scheduleId) {
            await step.run(`activity-${slot(ticketId)}`, () =>
              recordScheduleActivity({
                tenantId,
                scheduleId,
                projectId,
                drainRunId: drainId,
                kind: "ticket-advanced",
                reason: outcome,
                ticketId,
                metadata: {
                  finalStatus,
                  slot: slot(ticketId),
                  total: ticketIds.length,
                  parallelism,
                },
              }),
            );
          }
        },

        sleep: (pollRound) => step.sleep(`wait-${pollRound}`, `${POLL_INTERVAL_SECONDS}s`),

        // WI-5.4 — everything left in the backlog is waiting on a parent that is
        // DONE and merely awaiting its landing. Wait for the land worker instead
        // of forcing the ticket (which would record it `stuck` and drop it, a
        // race with a worker that is seconds from unblocking it). A distinct step
        // id from `sleep` so the two can never collide on a replay.
        waitForLand: (waitRound) =>
          step.sleep(`land-wait-${waitRound}`, `${POLL_INTERVAL_SECONDS}s`),

        // The drain gave up waiting. The ticket is LEFT IN BACKLOG - not started,
        // not failed, not dropped. WI-4's land-success emits a fresh
        // `ticket-drain/requested`, so the moment the parent lands it is picked
        // straight back up.
        onDeferred: (ticketId) =>
          comment(
            `deferred-comment-${slot(ticketId)}`,
            ticketId,
            `Waiting on a blocker that is done but hasn't landed on the integration branch yet. ` +
              `Left in the backlog; it drains automatically once the blocker lands.`,
          ),

        poll: (inFlightIds, pollRound) =>
          step.run(`poll-${pollRound}`, async () => {
            const svc = supabaseService();
            const { data } = await svc
              .from("tickets")
              .select("id, status")
              .in("id", inFlightIds as string[]);
            const out: Record<string, TicketStatus | null> = {};
            for (const id of inFlightIds) out[id] = null; // vanished unless found
            for (const row of data ?? []) out[row.id as string] = row.status as TicketStatus;
            return out;
          }),
      },
    });

    // 4. Final activity row for the drain so the Activity panel has a
    //    clean "completed" delimiter between drains. Includes the per-outcome
    //    tally so the operator can scan results at a glance.
    if (scheduleId) {
      const tally = summary.reduce(
        (acc, s) => {
          acc[s.outcome] = (acc[s.outcome] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      await step.run("activity-completed", () =>
        recordScheduleActivity({
          tenantId,
          scheduleId,
          projectId,
          drainRunId: drainId,
          kind: "completed",
          metadata: { drained: summary.length, tally },
        }),
      );
    }

    // 5. Clear the schedule's running pointer.
    if (scheduleId) {
      await step.run("clear-schedule", async () => {
        const svc = supabaseService();
        await svc
          .from("ticket_schedules")
          .update({ current_drain_run_id: null })
          .eq("id", scheduleId)
          .eq("tenant_id", tenantId);
      });
    }

    return { drained: summary.length, drainId, summary };
  },
);

// Start-of-day in UTC for `d`. Used to dedupe "fired today already" checks.
function utcStartOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

export const ticketScheduleCronFn = inngest.createFunction(
  {
    id: "ticket-schedule-cron",
    concurrency: { limit: 1, key: '"global"' },
  },
  { cron: "* * * * *" },
  async ({ step }) => {
    const now = new Date();
    const nowIso = now.toISOString();
    const todayWeekday = now.getUTCDay(); // 0=Sun..6=Sat

    // Pull active schedules and fire any matches. We do this in a single
    // step so the cron tick can re-fire idempotently — `last_fired_at` is
    // bumped per-row before we emit.
    const fired = await step.run("scan-and-fire", async () => {
      const svc = supabaseService();
      const { data: rows, error } = await svc
        .from("ticket_schedules")
        .select(
          "id, tenant_id, project_id, mode, days_of_week, time_of_day, run_at, last_fired_at, drain_parallelism",
        )
        .eq("status", "active");
      if (error) throw new NonRetriableError(`scan failed: ${error.message}`);

      const firedList: Array<{
        scheduleId: string;
        tenantId: string;
        projectId: string;
        drainParallelism: number;
      }> = [];

      const nowMs = now.getTime();
      const windowStartMs = nowMs - SCHEDULE_MATCH_WINDOW_MINUTES * 60_000;

      for (const r of rows ?? []) {
        const id = r.id as string;
        const tenantId = r.tenant_id as string;
        const projectId = r.project_id as string;
        const mode = r.mode as "once" | "recurring";
        const lastFired = (r.last_fired_at as string | null) ?? null;
        const lastFiredMs = lastFired ? new Date(lastFired).getTime() : 0;

        let shouldFire = false;
        if (mode === "recurring") {
          const days = (r.days_of_week as number[] | null) ?? [];
          const tod = (r.time_of_day as string | null) ?? null;
          if (!tod) continue;
          // Day-of-week match? Empty array = "every day" (operator
          // convenience — the UI also lets them tick all 7).
          const dayMatch = days.length === 0 || days.includes(todayWeekday);
          if (!dayMatch) continue;

          // Widened HH:MM match. Compute today's scheduled timestamp UTC,
          // then fire if it's in [windowStart, now] AND we haven't already
          // fired for this scheduled occurrence (lastFired < scheduled).
          const [hhStr, mmStr] = tod.split(":");
          const todHH = Number(hhStr);
          const todMM = Number(mmStr);
          if (!Number.isFinite(todHH) || !Number.isFinite(todMM)) continue;
          const scheduledTodayMs = utcStartOfDay(now).getTime() + (todHH * 60 + todMM) * 60_000;

          if (scheduledTodayMs > nowMs) {
            // Not yet — today's tick hasn't reached the schedule time.
            continue;
          }
          if (scheduledTodayMs < windowStartMs) {
            // Stale — the window has passed. Fall through to tomorrow.
            continue;
          }
          if (lastFiredMs >= scheduledTodayMs) {
            // Already fired this occurrence (or a later one).
            continue;
          }
          shouldFire = true;
        } else {
          const runAt = (r.run_at as string | null) ?? null;
          shouldFire = !!runAt && runAt <= nowIso && !lastFired;
        }

        if (!shouldFire) continue;

        // Automation pause gate. If the workspace OR the schedule's project
        // is paused, skip without bumping last_fired_at — the missed-
        // schedules banner uses the pause window vs last_fired_at to surface
        // what would have fired so the operator can run-now on resume.
        const automationGate = await getEffectivePause(tenantId, projectId);
        if (automationGate.paused) {
          // Best-effort activity row so the operator can see *why* this
          // schedule didn't fire when they expected it to.
          await recordScheduleActivity({
            tenantId,
            scheduleId: id,
            projectId,
            kind: "skipped",
            reason: automationGate.scope === "tenant" ? "paused-tenant" : "paused-project",
            metadata: { at: nowIso },
          });
          continue;
        }

        // CAS-style UPDATE so two cron invocations can't double-fire the
        // same row. We require `last_fired_at` to equal the value we saw.
        const updateBuilder = svc
          .from("ticket_schedules")
          .update({
            last_fired_at: nowIso,
            // For once-mode, mark completed so it doesn't fire again
            // when its run_at sits in the past forever.
            ...(mode === "once" ? { status: "completed" as const } : {}),
          })
          .eq("id", id)
          .eq("tenant_id", tenantId);
        const upd = lastFired
          ? await updateBuilder.eq("last_fired_at", lastFired).select("id")
          : await updateBuilder.is("last_fired_at", null).select("id");
        if (upd.error || !upd.data || upd.data.length === 0) continue; // lost the race

        firedList.push({
          scheduleId: id,
          tenantId,
          projectId,
          // The schedule row is the operator's window setting. Without this the
          // drain fell back to its default and `drain_parallelism` was inert for
          // every scheduled (as opposed to ad-hoc) drain.
          drainParallelism: resolveDrainParallelism(r.drain_parallelism as number | null),
        });
        await recordScheduleActivity({
          tenantId,
          scheduleId: id,
          projectId,
          kind: "fired",
          metadata: { at: nowIso, mode },
        });
      }
      return firedList;
    });

    if (fired.length === 0) return { fired: 0 };

    // Emit drain events for each matched schedule.
    await step.run("emit-drains", async () => {
      await Promise.all(
        fired.map((f) =>
          inngest.send({
            name: "ticket-drain/requested",
            data: {
              tenantId: f.tenantId,
              projectId: f.projectId,
              scheduleId: f.scheduleId,
              drainParallelism: f.drainParallelism,
            },
          }),
        ),
      );
    });

    return { fired: fired.length };
  },
);
