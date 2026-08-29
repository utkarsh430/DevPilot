// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.
//
// ══════════════════════════════════════════════════════════════════════════
//  EVERY SIGNAL IN THIS FILE WAS READ OUT OF THE CODE. KEEP IT THAT WAY.
// ══════════════════════════════════════════════════════════════════════════
//
// This is the section someone reads when the app is not cooperating, and a
// plausible-sounding wrong signal sends them after the wrong fix — which is
// strictly worse than saying nothing, because they will trust it. Anything
// quoted here as an observable string is a literal that exists in the tree:
//
//   • "no runner has registered" / "offline · last beat …"
//        lib/health/probes.ts → deriveRunnerHealth
//   • the ticket LEAVES Ready with no runner
//        lib/engine/dispatcher.ts → the `prepare-run` step transitions
//        ready → in_progress BEFORE anything is enqueued for a runner. The
//        intuitive "it stays in Ready" is WRONG whenever the engine is up,
//        and the run row is the honest discriminator.
//   • "local-cc step N timed out after 1h"
//        lib/engine/run-agent.ts → LOCAL_CC_TIMEOUT + the `lc-await` throw
//   • "Not landed — land failed" and its siblings
//        lib/integration/landing-state.ts → NOT_LANDED_LABELS (verbatim)
//   • "refusing to allow an OAuth App to create or update workflow …"
//        lib/github/scopes.ts header (GitHub's own wording)
//     and "push rejected: this branch changes a GitHub Actions workflow file"
//        lib/engine/land-worker.ts → explainPushFailure
//   • the model fallback line
//        apps/runner/src/claude.ts, the `isModelUnavailableError` branch
//   • devpilot_qa_retry_ceiling, and the human-only reset
//        lib/board/qa-retry.ts + lib/board/transitions.ts
//   • the two workspace-unavailable messages
//        lib/dev-servers/workspace-path.ts → classifyWorkspaceAvailability
//   • the ~30-minute orphan recovery and devpilot_orphan_reaper
//        lib/engine/orphan-ticket-policy.ts → ORPHAN_GRACE_SECONDS_DEFAULT
//
// No figures are declared. Both captured figures are already claimed by other
// sections and figure ids are globally unique across the guide (asserted in
// `__tests__/manifest.test.ts`), so this prose has to stand alone — which suits
// a chapter read while something is broken.

export const TROUBLESHOOTING = `
Most DevPilot failures are quiet. The engine records what happened, correctly,
and the record is somewhere you were not looking. So the useful question is
almost never "what went wrong" — it is **which surface is telling the truth
right now**.

This section pairs the failure modes people actually hit with the exact signal
each one produces.

## Start here: three places, in this order

1. **The ticket card.** Landing state and safety state surface as a chip on the
   card, with the reason as visible text rather than something you have to hover
   to find.
2. **The ticket's comments.** Every automatic intervention writes one, under its
   own author, saying what it did and why.
3. **The Runs page.** Whether a run exists at all — and how far it got — is the
   single most discriminating fact available.

A run that failed says so at the top of its own inspector, carrying the engine's
reason rather than a generic error.

![](figure:run-failed)

> [!TIP]
> A comment attributed to something machine-shaped — \`devpilot_qa_retry_ceiling\`,
> \`ticket-reconciler\`, \`devpilot_orphan_reaper\` — is the engine talking, not an
> agent. Those are the ones worth reading closely: each one exists because a
> specific failure was found to be invisible without it.

---

## "I moved a ticket to Ready and nothing happened"

The most common first-run failure, and it has **three different causes with
three different signals**. The discriminator is the Runs page, not the board.

| What you see | What it means |
|---|---|
| A run exists, at *running*, with no steps | The engine did its job. Nothing claimed the work. |
| **No run at all**, and a comment about a WIP limit | Deferred on purpose. It will release itself. |
| **No run at all**, and no comment | The dispatch itself was never picked up. |

### A run exists but never moves — no live runner

This is the usual one. Note what it does **not** look like: the ticket does
*not* stay in Ready. The dispatcher moves it Ready → In Progress and creates the
run before anything is offered to a runner, so with no runner alive you get a
ticket that looks like it is being worked on and a run that never accumulates a
step.

Confirm it in **Settings → System health**, on the Local runner card:

- *"no runner has registered"* — none has ever connected.
- *"offline · last beat 6m ago"* — one connected and then stopped or died.

Start one, and leave it running:

\`\`\`bash
pnpm --filter @devpilot/runner dev
\`\`\`

If you leave it, the run does not hang forever. After **one hour** the step
gives up and the run fails with \`local-cc step 0 timed out after 1h\`, and the
engine sends a kill request in case the process on the runner host is still
alive.

> [!WARNING]
> Do not start a second runner as insurance. Runners poll a shared queue on a
> timer, and stacked runners have exhausted a free-tier request cap here before
> — which breaks the hand-off *silently*, with every queue operation failing and
> nothing red on any screen. Kill the old process first.

### Still in Ready with a WIP comment — deferred, not broken

This is the one case where a ticket genuinely does sit in Ready, and it is
working as intended. Each agent has a limit on how much it works at once; a
ticket that arrives over that limit is parked with a comment from \`dispatcher\`
naming the count and the limit, and released automatically when one of that
agent's other runs finishes.

Nothing to fix. If you want more of them moving at once, raise the agent's WIP
limit or the board's drain parallelism — not the number of runners.

### No run at all — nothing consumed the dispatch

Moving a ticket emits a durable event, and something has to consume it. Running
locally, that something is the Inngest dev server, and it is **not** started by
\`pnpm dev\`:

\`\`\`bash
pnpm --filter web dev:inngest
\`\`\`

With it down, the event reaches nothing, no run row is ever created, and the
board simply stops progressing. Nothing errors, because from the app's point of
view the work was handed off correctly.

---

## The ticket says Done but the code is not on the integration branch

**Done and landed are different facts.** Done means a reviewer approved the
work. Landing is what puts the commits on your integration branch afterwards,
and it can fail on its own, several ways.

The card tells you which, by name — but only when there is something to say. **A
ticket that landed cleanly gets no chip**, deliberately: Done already says it,
and a green badge on every healthy card makes the amber one harder to see. So a
chip on a finished ticket always means read me.

These are the exact chips:

| Chip | What actually happened |
|---|---|
| **Nothing to land** | The ticket produced no commits. Healthy — most review and planning work is this. |
| **Landing…** | Claimed and in flight right now. Transient. |
| **Not landed — conflict** | A rebase conflicted and nobody has resolved it. |
| **Not landed — push failed** | Commits exist locally and never reached GitHub. |
| **Not landed — land failed** | The worker tried and recorded why. The detail names the cause. |
| **Not landed — stuck in queue** | Queued, and no worker ever claimed it. |
| **Not landed — awaiting merge** | Parked: a merger ticket owns resolving it first. |
| **Not landed** | Commits exist and no record explains where they went. |

> [!NOTE]
> **"Nothing to land" is a success, not a warning**, and it is styled neutrally
> rather than as an alarm. A reviewer that read the code and changed nothing is
> correctly Done with nothing to ship. Treating that as a problem is how people
> learn to ignore the ones that are. It appears only where it is worth
> explaining — on a ticket that produced a branch and landed nothing from it.

Every chip carries its reason as text on the card, not just the state. That is
the whole point of the surface: "Not landed" on its own is what used to send
people into the database by hand.

One more thing the chip depends on: landing state is only shown once the ticket
has **finished**. An unlanded branch on a ticket still in progress is not
stranded, it is running, so it gets nothing.

---

## A push is rejected because of GitHub Actions

A distinctive one, because the credential looks fine and the failure names a
scope nobody chose.

**The signal.** The card reads **Not landed — land failed**, and the detail
begins:

\`\`\`text
push rejected: this branch changes a GitHub Actions workflow file, and the
connected GitHub OAuth grant does not carry the \`workflow\` scope.
\`\`\`

Underneath it is GitHub's own wording:

\`\`\`text
! [remote rejected] … (refusing to allow an OAuth App to create or update
workflow '.github/workflows/ci.yml' without 'workflow' scope)
\`\`\`

**Why it happens.** \`repo\` does not imply \`workflow\`. A grant with full
private-repository write access is still refused for any push whose diff touches
\`.github/workflows/\`. DevPilot's agents set up CI, so this is not an edge case:
without that scope, every ticket that adds or edits a workflow file is
permanently unlandable.

**The fix, and the part people miss.** Reconnect GitHub at **Settings → GitHub
integration**. An already-issued token **never gains new scopes on its own** —
so a connection made before the scope was requested keeps failing until somebody
re-authorises, no matter how many times the land is retried.

> [!WARNING]
> Granting \`workflow\` is a real widening, not a formality: whoever can edit CI
> can make CI run arbitrary code with that repository's Actions secrets. It is
> the right trade if you want agents setting up CI. It is worth knowing you are
> making it.

---

## An agent is not running the model you pinned

The awkward one, because **the run succeeds**. Nothing fails, nothing is
flagged, and the work comes back — from a different model than the one you
chose.

There are two distinct versions and only one of them is visible in the app.

### Pinned to something DevPilot does not recognise — visible

The engine allowlists model ids before sending one, so a value it refuses is
simply not passed on. The agent and scoreboard surfaces say so: the effective
model reads **Account default**, and where an override exists but is inert it is
rendered as *"… (opus not in effect)"* rather than being hidden.

### Pinned to a real model that is not on your plan — only in the runner log

DevPilot cannot know which models your subscription actually includes; that
depends on your plan, not on the code, and only the \`claude\` CLI finds out at
spawn time. When it fails for that reason the runner **retries once without the
pin** and lets the account default answer. So the ticket completes normally, and
the only trace is one line in the runner's own output:

\`\`\`text
[devpilot-runner] model "opus" is not available on this subscription (…).
Retrying on the account default — fix the project's LLM model setting to
silence this.
\`\`\`

Failing the ticket instead would be worse — the two outcomes are "runs on a
different model" and "does not run" — but it does mean a model setting can be
wrong for weeks without anything on screen saying so. If a pinned model seems to
be having no effect, that log line is where the answer is.

---

## The engine stopped this ticket on purpose

Several mechanisms deliberately halt a ticket rather than spend more on it, and
every one of them writes a comment under its own author. The author is the
fastest way to tell them apart — and note that they do not all land in the same
place.

| Comment author | What stopped it | Where the ticket ends up |
|---|---|---|
| \`devpilot_qa_retry_ceiling\` | The engineer and reviewer stopped converging | Blocked |
| \`devpilot_qa_gate_ceiling\` | Hand-off to review was refused too many times | Blocked |
| \`devpilot_safety_gate\` | Safety-critical, so only a human may mark it Done | Blocked |
| \`ticket-reconciler\` | A reviewer finished without recording a verdict | Blocked |
| \`devpilot_workspace_precondition\` | A code-producing role with no repository to work in | The **run fails**; the ticket does not move |
| \`billing-gate\` | Negative balance with no valid card | The ticket does not move |

The last two are worth separating out, because the ticket looks untouched. A
workspace precondition refusal happens *before* any money is spent — a role that
delivers committed source was dispatched against a project with no repository
resolved, so the run is refused rather than run blind. Its comment names the
role and tells you to connect a repository and re-trigger. A billing refusal is
the same shape: the run never starts, and the comment names your balance and
points at **Settings → Billing**.

### The QA retry ceiling

The engineer ↔ reviewer loop is bounded, and it has to be: two agents that
disagree will bounce a ticket between themselves indefinitely, and each lap
costs a full engineer run plus a full review run.

**The signal.** The ticket is in Blocked with a comment from
\`devpilot_qa_retry_ceiling\` naming the count and the ceiling (three rejections by
default, i.e. four engineer attempts). Its text tells you what to do: read the
rejection comments above it, then either sharpen the acceptance criteria, make
the change yourself, or close the ticket.

**Recovering it.** Moving the ticket out of Blocked resets the retry budget, so
the loop gets a fresh set of attempts. That reset is deliberately **human-only**
— no agent or engine path can refill its own budget — which is exactly what
stops the park from being a permanent wedge and equally stops it from being no
bound at all.

---

## A workspace that is not there any more

Workspaces are real directories on the machine the runner runs on. Two things
break that link, and DevPilot distinguishes them because the recovery differs.

**Recorded on another host.** The stored path is not under this machine's
workspace root at all:

\`\`\`text
This change was recorded on another host, at a path that does not exist here
(/Users/someone-else/.devpilot/workspaces/…). Its commits are not on this
machine.
\`\`\`

This is what a shared, restored or copied database looks like — and also what
**moving the runner to a new host** looks like. It is worth knowing that the
workspace root default is \`~/.devpilot/workspaces\`; a host that predates the
rename has real clones under the older \`~/.ace/workspaces\`, some holding the
only copy of an unpushed commit. Pin \`WORKSPACE_ROOT\` at the old location rather
than letting the new default reclassify every stored path as foreign.

**Cleaned up on this host.** The path is ours and the directory is gone:

\`\`\`text
The workspace for this change no longer exists on disk (…) - it was cleaned up
before the branch was pushed.
\`\`\`

Either way, if a diff was saved for the change it can be replayed onto a fresh
clone and pushed — *Rebuild from saved diff*. The tree is restored faithfully;
the original commit history is not, and the reconstructed commit says so.

> [!NOTE]
> DevPilot refuses to delete a workspace that holds commits on a branch which
> never reached a remote — in two independent places, both failing closed. The
> hold is released by pushing or discarding the change. If a cleanup seems
> stuck, that is usually why, and it is protecting the only copy of something.

---

## A ticket that stopped responding entirely

If a run dies in a way that leaves nothing behind, a ticket can sit in In
Progress with no live run and no queued work — and in that state replying to it
does nothing, because a reply only re-triggers work on a ticket that is waiting
for one.

You do not have to catch this yourself. After about **30 to 35 minutes** of no
activity, the engine hands it back:

- **In Progress** becomes **Input Required**, which is the state where your next
  comment provably starts a fresh run.
- **In Review** becomes **Blocked**.

Either way a comment appears under \`devpilot_orphan_reaper\` naming how long it
was idle, what the last run's status was, and how to resume. It also says
outright that it is a *recovery, not a diagnosis* — it knows the ticket was
stranded, not why.

Nothing is auto-retried. Re-running work that already failed once, with no
information about why, is how a loop and a bill start.

---

## Stopping things

Two pause controls exist and their blast radii are very different.

| Control | What it halts | What moves |
|---|---|---|
| **Pause on a ticket** | That ticket's run | The ticket moves to Paused |
| **Pause automation** | Every in-flight run in the scope | No ticket moves |

Automation pause is scoped to a **project** from the board button, but the same
mechanism can be applied to the whole workspace — at which point it halts
in-flight runs across *every* project. Neither is a kill: runs stop at the next
step boundary, never mid-command, leaving a checkpoint to resume from.

## When the answer is not here

Two things are worth doing before digging further. Open the run in the Runs page
and read its steps — the trace is the product, and a run that did something
surprising did it in a step you can read. And export the ticket's audit PDF: it
carries the full thread, every run's narration, the cost, and the evidence
behind each verdict in one file.

If a term in a comment or on a card is unfamiliar, the
[glossary](/guide/glossary) defines the ones that carry specific meaning here.
`;
