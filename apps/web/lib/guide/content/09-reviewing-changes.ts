// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.

export const REVIEWING_CHANGES = `
An agent that writes code commits it locally, on a branch of its own, in a
workspace on the runner host. Getting from there to your integration branch is
two separate journeys — **pushed** and **landed** — and neither of them is what
the Done column means.

That is the whole point of this section. **Done is a verdict about the work.
Landed is a fact about the code.** They are set by different things, at
different times, and one of them can fail while the other already succeeded.

## The Changes page

**Changes** is the review queue. It lists work an agent has committed on a
\`devpilot/<slug>\` branch that has not reached GitHub yet, scoped to your active
project.

A row appears only when there is something to show: the tracker writes one after
a run only if the workspace actually holds at least one commit the remote does
not have. A ticket that changed nothing produces no row at all.

![](figure:changes-queue)

Opening a row shows the diff, file by file, plus:

- **Push** — pushes the branch to GitHub. It rebases onto the integration
  branch's current tip first, so what reaches the remote sits on top of current
  work rather than on a stale tree.
- **Open PR** — a toggle, on by default. Push with it on and you get a pull
  request as well as a branch.
- **Discard** — removes the row from the queue.

> [!NOTE]
> **Discard drops the review marker, not the work.** The commits stay in the
> workspace on the runner host, deliberately: the row is a marker that something
> is waiting for you, not the only copy of anything. It also means discarding is
> not a way to reclaim disk.

If the rebase conflicts, DevPilot does not silently force anything. It records
the conflict, and can spawn a merger ticket whose job is to resolve it in the
source ticket's own workspace. There is also an operator override that skips
the rebase and force-pushes, which is audited when you use it.

## What "landed" actually means

A ticket is **Done** when the reviewer approved it. Nothing about that says
where the code is.

A ticket is **landed** when its commits are on the project's integration branch
— typically \`dev\` — and DevPilot has recorded the exact commit that proves it.
Between those two moments sits the land worker, and it can fail on its own.

| | Set by | Means |
|---|---|---|
| **Done** | The reviewer's verdict | The work was judged acceptable |
| **Pushed** | A push to GitHub | The branch exists on the remote |
| **Landed** | The land worker | The commits are on the integration branch |

They happen in that order and none of them implies the next.

> [!WARNING]
> This is the single most misread thing in DevPilot, and it has bitten real
> projects: five Done tickets with their commits stranded, three of them on
> branches that had never reached GitHub at all. Every one of those failures was
> recorded faithfully in the database and none of it reached the board. That is
> now fixed — but the fix is a chip on the card, so it only helps if you know to
> read it.

### The three outcomes on a card

Once a ticket is settled, its card can tell you one of three things — and the
third one is not a failure.

| Chip | Meaning |
|---|---|
| *(nothing)* | Landed, or it never had a branch. The boring majority. |
| **Nothing to land** | It had a branch and produced no commits ahead of the integration branch. |
| **Not landed — …** | Its code is stranded. The chip names the reason. |

The reasons are specific on purpose, because "not landed" alone sends you
hunting: *conflict*, *push failed*, *land failed*, *stuck in queue*, *awaiting
merge*, or — if something happens that DevPilot does not recognise — the
recorder's own words, verbatim. An unrecognised failure surfaces as a problem
rather than as success.

**Nothing to land is healthy.** Most tickets produce no commits at all: the
non-code roles, spec work, a reviewer who read the code and correctly approved
it without changing anything. Rendering those as warnings would teach you to
ignore the warning, which is exactly the failure this exists to end.

![](figure:landing-not-landed)

## Auto-land

Auto-land is the machinery that closes the gap. It is a per-project setting,
armed by default when you create a project, with an instance-wide kill switch
(\`DEVPILOT_AUTO_LAND_ENABLED=0\`) that turns it off everywhere regardless.

If the integration branch could not be set up at project creation, auto-land is
deliberately left **off** rather than half-armed, and the project's **Branch
routing** card says so. That card is where you turn it on, and where you change
which branch counts as the integration branch.

When a ticket reaches Done, it is queued for landing. A worker then rebases the
branch onto the *live* integration tip, lands it as a squashed pull request,
and stamps the result on the ticket.

Two properties of that worker are worth knowing, because they explain behaviour
you will otherwise find strange.

**One land per project at a time, always.** Two workers rebasing onto the same
tip would each verify a tip the other is about to move. So landings queue behind
each other per project, and a busy board lands sequentially even though the
agents ran in parallel.

**The recorded commit is read back from the branch, never taken from the merge
response.** If a worker merges and then dies, the replay asks GitHub to merge an
already-merged branch, and GitHub correctly answers "already up to date" — with
no commit id. Recording that would mark the ticket landed while pointing at
nothing, which is unrecoverable and silent. So the worker always re-reads the
integration branch, and if it cannot, it refuses to record a landing at all and
leaves the row for the reaper.

### Why this gates other tickets

Readiness is gated on **landed**, not on Done, and that is the reason the
distinction is enforced rather than merely displayed. A ticket that
[builds on](/guide/your-first-ticket) another and starts in the gap between its
parent's approval and its parent's landing would branch off an integration tip
that does not contain its parent's work — and then re-implement it, or conflict
with it.

So a dependent waits for the landing. On the board its blocker shows as
**waiting to land**, and it clears itself when the worker gets there. A blocker
that never owed a landing — a spec ticket, a design ticket, anything that
produced no branch — closes the moment it is Done, so non-code work never wedges
anything.

## The two escape hatches

Both live in the ticket drawer's header, and both are human-only.

**Land into dev** appears on a Done ticket that still has an unpushed change in
the review queue. It drives the *same* pipeline auto-land uses — it never
reimplements the merge — so it needs the same things to be true: a connected
repository, an integration branch, and auto-land enabled for the project. If any
of those is missing you get told which one.

**Restart from dev** appears on a Done or Paused ticket. It reopens the ticket
to Backlog and forces its next run to fresh-clone the current integration
branch, so the work is rebuilt on top of everything that has accumulated since.
It clears the landing stamp too, so re-completed work can land again.

There is a third, deliberately separate control — **Discard & restart** — for a
ticket that is still in progress, paused, blocked or waiting on you. It throws
away that ticket's uncommitted and unpushed work and sends it back to Backlog to
run again from scratch. It is styled as destructive and it makes you type
\`discard\` to confirm, because it is the one control here that is designed to
lose work.

## The guard that refuses to restart

**Restart from dev refuses when the ticket's branch holds commits that exist
nowhere else.** It lists the branches and tells you to land, push or discard
them first. This is not caution for its own sake — restarting fresh-clones the
workspace, and that workspace is the only copy.

The test is simple and deliberately blunt: **is there a pending push for this
ticket that has never been pushed?** Not "does it claim more than zero commits"
— a stale or zero count on a live row would re-open the exact hole this closes.
A row exists at all only because commits were found, and holding a workspace
costs disk while reaping one costs the work.

> [!NOTE]
> Uncommitted and untracked files are **not** part of the test, and that is
> deliberate. Every settled workspace is full of build output and installed
> packages; holding on a dirty tree would hold every workspace forever. Committed
> work is what an agent decided was worth keeping, and it is what the guard
> protects.

There are two independent guards, not one. The engine declines to enqueue the
cleanup, reading its record of the workspace. The runner then refuses again,
immediately in front of the delete, by asking the workspace itself for any
commit reachable from a local branch and from no remote. That second check also
covers cases the first cannot see — a cleanup queued before those commits
existed and only executed afterwards, or a run that crashed before writing any
record at all. **If it cannot answer the question, it keeps the workspace:** git
missing, the command timing out, git failing for any reason. Keeping a workspace
that could have been deleted costs disk; the other mistake is not recoverable.

**Pushing is what releases the hold cleanly.** Once the commits are on the
remote, both guards agree the workspace is redundant and the next cleanup pass
sweeps it normally.

Discarding from the Changes queue is not the same thing, and it is worth knowing
why. It drops the review marker, so the ticket stops asking for your attention
and the engine stops holding on its account — but the commits are still sitting
in the workspace, so the runner's own check still finds them and still declines
to delete it. Nothing is lost and nothing breaks; the workspace simply stays on
disk. If you genuinely want that work gone, **Discard & restart** on the ticket
is the control that says so out loud.

> [!TIP]
> You will also see this from the other side: a ticket that reaches Done with an
> unpushed branch gets a comment on its own thread saying so, naming the branch
> and linking to the diff. That one is a **notice, not a gate** — the ticket still
> completes. It exists so the gap is visible on the ticket rather than only in a
> queue you might not open.

---

If a ticket has stalled somewhere in all of this and you cannot tell where, the
card's chip is the first thing to read and the run inspector is the second. And
if nothing is moving at all, check the runner before anything else — see
[Connect a runner](/guide/connect-a-runner).
`;
