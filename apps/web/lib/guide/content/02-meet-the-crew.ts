// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.
//
// Every factual claim here is read off the code, not remembered:
//   • the catalogue shape — `lib/roles/catalog.ts` (52 entries, 10 categories)
//   • producer vs reviewer — `RoleConfig.onSuccessStatus` across `lib/roles/*`
//     (`in_review` for almost all; `done` for qa/verifier/release_engineer;
//     `ready` for pm; `in_progress` for triage)
//   • the retry ceiling — `lib/board/qa-retry.ts` (`DEVPILOT_QA_MAX_RETRIES`,
//     `DEFAULT_QA_MAX_RETRIES = 3`) and the dispatcher's first step
//   • agent-filed tickets — `projects.agent_ticket_creation`, still `default
//     false` in migration `20260717000000`. The COLUMN default is unchanged;
//     what changed (20260754000000 / the create-form toggle) is that both
//     project-creation forms carry a visible, pre-ticked control, so a project
//     made through the UI arrives armed by the operator's own choice while an
//     existing project is never armed underneath its owner. The prose below
//     says "you are asked at creation", not "it is on by default", because
//     those are different claims and only the first is true.
//   • the per-run ceiling — `projects.agent_ticket_max_per_run` (NULL =
//     inherit) » `DEVPILOT_MAX_TICKETS_PER_RUN` » `DEFAULT_MAX_TICKETS_PER_RUN`
//     (3), resolved by `resolveMaxTicketsPerRun` in `lib/board/agent-ticket.ts`.

export const MEET_THE_CREW = `
A role is a brief, not a person and not a separate product. Every agent runs on
the same engine; what differs is the standing instructions it carries and where
in a ticket's lifecycle it is allowed to act. That is why "hire a QA" costs
nothing here, and why a role you never chose can still show up on your board.

## The catalogue, and the roles that matter first

There are over fifty roles, grouped into ten categories — leadership,
engineering, data, infrastructure, quality and security, design, go-to-market,
operations, platform, and the one you will actually watch: **Workflow**. The
specialists exist so a plan can put the right lens on a ticket. The workflow
roles are the ones that make a ticket move at all.

| Role | What it picks up |
|---|---|
| PM | Turns a rough description into a title, a description and acceptance criteria |
| Engineer | Implements the change — the generalist, when no specialist fits better |
| QA | Reviews and tests the work, then approves or rejects it |
| Verifier | Runs the build and a smoke check after QA, so nothing is marked done if the app will not boot |
| Security | Sibling reviewer — reads the diff for auth, crypto and injection problems |
| Tech Lead | Reviews architectural choices and unblocks engineers |
| Triage | Reads an inbound ticket and emits a routing signal |
| Release Engineer | Auto-spawned when a push conflicts; resolves it and hands back a clean branch |

> [!NOTE]
> The specialist roles are not a different mechanism. A frontend engineer and a
> generic engineer both finish by handing their ticket to review; they differ in
> what their brief tells them to care about, and in which skills and lessons the
> engine considers relevant to them.

## The handoff chain

The canonical loop is four steps: PM refines, Engineer implements, QA reviews,
Security audits. Drawn as boxes and arrows it looks like a pipeline, which is the
one thing worth correcting — because the interesting part is what the arrows
actually *are*.

![](figure:handoff-chain)

An arrow is a ticket move plus what the agent wrote on the way past. Nothing is
handed over in memory, nothing is held in a conversation, and no agent waits on
another. An engineer finishing a ticket does not call QA — it moves the ticket to
In Review and stops. Later, possibly much later, the dispatcher looks at a ticket
sitting in In Review and starts a QA run.

Three things follow from that, and they are the reasons the design is worth the
indirection:

- The chain survives everything. A crash, a restart, or a week between the
  engineer finishing and you looking at the board changes nothing, because the
  state was never anywhere but the ticket.
- You are a participant, not an observer. Moving a ticket yourself is the same
  kind of act as an agent moving it, and it is honoured the same way.
- Every handoff left a trace, because writing it down is *how* it happened.

## Producers and reviewers

Roles split into two kinds, and the split is a single field on each role's
configuration rather than a naming convention.

Almost every role is a **producer**: when its run succeeds, its ticket lands in
**In Review**. That includes roles you might not think of as producing code — a
technical writer, a product manager and a designer all hand their ticket to
review exactly as an engineer does.

Only three roles can carry a ticket to **Done** on their own: **QA**,
**Verifier** and **Release Engineer**. Two more end somewhere else entirely — PM
finishes at **Ready** (its output is a refined ticket, not finished work), and
Triage finishes at **In Progress** (its output is a routing decision).

> [!TIP]
> A role whose work goes to review is *told so* in its brief. That is deliberate:
> an agent that knows a reviewer is coming writes for the reviewer — it leaves
> the note explaining the odd decision instead of assuming nobody will look.

### Which roles actually write code

"Producer" is not the same as "writes code", and DevPilot keeps a deliberately
tight list of the roles that commit: the generic engineer, the front-end,
back-end, full-stack and mobile engineers, and the project scaffolder. Everything
else is expected to be able to finish a ticket having changed no files — a
security reviewer that read the diff and found nothing wrong has done its job
completely.

## Why QA can send work back

A rejection is not an error. QA moving a ticket from In Review back to In
Progress is an ordinary, expected transition: it attaches the reviewer's notes,
and the engineer picks the ticket up again knowing exactly what failed. That is
the whole point of having a reviewer role rather than trusting the producer's own
opinion of its work.

Left alone, that loop does not terminate. An engineer and a QA that genuinely
disagree will bounce a ticket between themselves forever, and each lap costs a
full engineer run *plus* a full QA run — on your budget.

So the loop is bounded. Every rejection increments a retry counter on the ticket,
and once it reaches the ceiling the ticket is parked in **Blocked** with a
comment explaining why, instead of being handed to the engineer again.

| The ceiling | |
|---|---|
| Setting | \`DEVPILOT_QA_MAX_RETRIES\` |
| Default | 3 rejections, which is 4 engineer attempts in total |
| At the ceiling | The ticket is parked to Blocked, before a role is even chosen |
| Recovery | **You** move it out of Blocked, which resets the counter |

Two details are worth knowing because they are easy to assume backwards.

The ceiling is checked *first*, before the dispatcher picks a role at all, so an
exhausted ticket costs nothing further — it does not start a run and then abandon
it. And the reset is human-only: no agent, and no part of the engine, can refill
a ticket's retry budget. A ticket parked at the ceiling stays parked until a
person decides what to do, which is the right answer when a producer and its
reviewer have failed to converge four times running.

> [!WARNING]
> Blocked is a *park*, not a failure. The work is intact and the ticket is fully
> recoverable — read QA's rejection comments, then either sharpen the acceptance
> criteria, make the call yourself, or close the ticket. Moving it out of Blocked
> gives the loop a fresh budget.

---

## Roles that arrive uninvited

Not every agent on your board was chosen by you, and each of these has a reason.

- **Release Engineer** appears when a ticket's branch will not rebase cleanly. It
  resolves the conflict on that branch and hands it back for the push to retry.
- **Verifier** runs after QA approves, so that "the reviewer was happy" and "the
  application still boots" are two separate claims rather than one assumed one.
- **Project scaffolder** runs once, on a brand-new repository, because DevPilot
  deliberately creates that repository empty — see
  [Create your first project](/guide/create-your-first-project).

An agent can also file a *new* ticket when it finds work genuinely outside its
own scope, rather than quietly widening the ticket it was given. It is a
per-project permission, and both project-creation forms ask you about it
directly — the box is ticked for you, and unticking it before you submit is how
you say no. A project made before you were asked, or one you unticked, has it
off; the switch is on the project page under **Agent autonomy**.

Even when it is on, an agent-filed ticket lands in Backlog and can never
dispatch itself. Something — you, or a dependency completing — has to promote
it.

There is a second half to the setting, and it is worth knowing before you need
it. One run may only file so many tickets, and the ceiling is deliberately low
by default: an engineer that notices two or three stray things while doing its
ticket is the case it was sized for. A ticket whose whole job is to be broken
into children is *not* that case, and it will hit the ceiling part-way through.

| The ceiling | |
|---|---|
| Default | 3 tickets per run |
| Per project | **Agent autonomy → "Tickets one run may file"** on the project page |
| Instance-wide | \`DEVPILOT_MAX_TICKETS_PER_RUN\` |
| Resolution order | The project's own number, then the instance-wide one, then the default |

> [!WARNING]
> An agent that hits the ceiling mid-decomposition has produced an *incomplete*
> set of tickets, and the ones it never filed look exactly like ones it never
> planned. The refusal tells the agent so in as many words and instructs it to
> write the remainder into a comment with a count — but if you are filing a
> ticket that says "break this into five", raise the ceiling first.

Next: [Before you start](/guide/before-you-start) covers what has to exist on
your machine before any of this crew can run.
`;
