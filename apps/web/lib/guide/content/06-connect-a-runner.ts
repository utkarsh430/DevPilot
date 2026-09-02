// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.
//
// ACCURACY NOTE for whoever edits this next. This section used to say the
// missing-runner signal was "Ticket stuck in Ready". That is FALSE, and it was
// false in a way that reads as obviously true, which is why it survived review.
// Read out of the code, in dispatch order:
//
//   • `lib/board/transitions.ts` - moving a ticket to Ready emits
//     `ticket/dispatch-needed` (the default; only done/failed/input_required/
//     paused suppress it).
//   • `lib/engine/dispatcher.ts` - `DEFAULT_ASSIGNMENT_MODE` is `"push"`, and
//     the `prepare-run` step transitions ready → in_progress BEFORE
//     `agent/run.requested` is emitted. No runner is consulted at any point.
//   • `lib/engine/run-agent.ts` - the `init` step upserts the run row at
//     `status: "running"` (line ~189); the Redis LPUSH onto the runner queue is
//     far later, inside `lc-enqueue-${i}` (line ~695). So the run row exists,
//     at `running`, before anything is offered to a runner.
//   • `run_steps` rows are only written AFTER `lc-await-${i}` receives a
//     `runner/step-result`, so with no runner the run accumulates zero steps
//     and then fails at `LOCAL_CC_TIMEOUT` (1h) with
//     `local-cc step 0 timed out after 1h`.
//   • `lib/health/probes.ts` → `deriveRunnerHealth` - the two card details are
//     verbatim: "no runner has registered" (zero rows) and
//     "offline · last beat <age> ago" (rows exist, none fresh).
//
// WHY THE PROSE DOES NOT HEDGE ON ASSIGNMENT MODE. The old row is sometimes
// defended as "true for a `pull`-mode agent". It is not true there either, and
// pull mode is unreachable from the product anyway:
//
//   • Every `materialize_builtin_agents` seed writes `'assignment_mode', 'push'`
//     (six migrations under `supabase/migrations/`), and NOTHING in `apps/web`
//     or `apps/runner` ever writes `'pull'` - only a hand-edited `agents.config`
//     produces it. The dispatcher's own header says so: "'pull' is not
//     exercised by the standard scenarios".
//   • Even in pull mode the ticket is not waiting on a RUNNER. The `pull` fork
//     marks `assignee_agent_id` and stops; the claim UI it waits for does not
//     exist ("A future 'claim' UI / poller picks it up"). Starting a runner
//     would move nothing.
//
// So there is no mode in which "stuck in Ready → start the runner" is correct,
// and naming a mode a reader cannot reach would trade one wrong signal for a
// confusing one. The prose states the default behaviour plainly. If a claim UI
// ever ships, revisit this note before revisiting the prose.
//
// The genuine "sits in Ready" cases are the WIP defer (a `dispatcher` comment
// names the count and the limit) and nothing consuming the dispatch at all -
// both owned by `13-troubleshooting.ts`, which this section links to rather
// than restating.

export const CONNECT_A_RUNNER = `
A runner is a process that executes agent steps. DevPilot's engine decides *what*
should happen and records it durably; the runner is what actually opens your
repository, edits files and runs commands. Nothing moves without one.

This is the step people skip, because everything up to it succeeds. You can
create a project, connect GitHub, file a ticket and move it to Ready with no
runner anywhere, and the app will not complain.

Worse than not complaining, it looks like it worked. The ticket leaves Ready for
In Progress and a run appears on the Runs page. The engine does both of those on
its own, before a runner is involved at all — so what you are looking at is work
queued correctly, waiting for something that is not there.

![](figure:runner-connected)

## Start the default runner

The default runner executes steps through your own Claude subscription, so there
is no per-token bill and no API key to manage. It needs the \`claude\` CLI
installed and signed in.

\`\`\`bash
pnpm --filter @devpilot/runner dev
\`\`\`

Leave it running. It has no web interface; it reaches the engine over HTTP and
reports back as it works.

## Confirm it actually connected

Starting the process is not the same as it being connected — a runner with the
wrong keys starts cleanly and then fails every poll. Most of what happens after
you move a ticket to Ready happens whether or not a runner exists, so confirm it
with signals only a live runner can produce. Check all three:

1. The runner log prints a claim line within a few seconds of a dispatch.
2. The run on the Runs page **accumulates steps**. A run sitting at *running*
   with no steps is a run nothing has claimed.
3. **Settings → System health** shows the Local runner card online.

If the log claims the job and the run then fails without recording a step, the
runner is alive and failing on the job itself — its own output carries the
reason. If the process is running and System health still reads *no runner has
registered*, it never connected: its heartbeat is being rejected, which is
almost always the runner keys.

> [!NOTE]
> **A ticket leaving Ready proves nothing about the runner.** The engine moves it
> Ready → In Progress and creates the run *before* the work is offered to a
> runner, so that happens identically with no runner running. It is the most
> commonly misread signal in DevPilot, which is why it is called out here rather
> than listed above.

> [!WARNING]
> Do not start a second runner "to be safe". Each one polls Redis on a timer, and
> stacked runners have exhausted the free-tier request cap here before — which
> breaks the hand-off silently, with every queue operation failing and no error
> on any screen. Kill the old process before starting a new one.

### The signals, and what each one means

| What you see | What it means | What to do |
|---|---|---|
| In Progress, run at *running*, no steps | Nothing claimed the work | Start the runner |
| System health: *no runner has registered* | None has ever connected | Start the runner |
| System health: *offline · last beat 6m ago* | One connected, then stopped or died | Restart it, then read its log |
| Runner logs auth errors | Keys mismatch | Re-check the runner keys |
| Run starts, then fails immediately | \`claude\` CLI not signed in | Sign in, restart |
| Several runner processes | Stacked runners | Kill all, start one |
| Genuinely still in Ready | Not a runner problem | See [troubleshooting](/guide/troubleshooting) |

Left alone, an unclaimed run does not hang forever: after one hour the step gives
up and the run fails with \`local-cc step 0 timed out after 1h\`.

> [!NOTE]
> A runner is tied to the machine it runs on. Workspaces are real directories on
> that host, so a run started on one machine cannot be resumed on another — this
> is why a moved or shared database can produce paths that do not exist locally.

---

## Concurrency

The subscription-backed runner suits roughly one to three concurrent agents.
Beyond that you are queueing against your own rate limit, which shows up as slow
steps rather than as an error.

> [!TIP]
> If you want more parallelism than that, raise it in the board's drain settings
> rather than by starting more runners — one runner handles several steps, and
> more processes do not buy more throughput from a single subscription.

Once a run completes, the board is where the result lands. If you have not read
it yet, [what DevPilot is](/guide/what-is-devpilot) explains why that matters more
than it sounds.
`;
