// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.

export const YOUR_FIRST_TICKET = `
A ticket is the unit of work and the unit of orchestration. Filing one is how
you ask for something; moving it is how you cause it to happen. This section
follows one ticket from the New-ticket dialog to Done, and names the two places
it can legitimately stop and wait for you.

## Filing it

**New ticket** on the board opens a dialog with four things that matter and one
that surprises people.

- **Title** — 3 to 200 characters. A slug of it becomes the ticket's branch
  name, so keep it descriptive.
- **Description** — up to 8,000 characters. This is the agent's brief. Say what
  "done" looks like; an agent cannot ask a question it does not know it has.
- **Role** — defaults to *Auto-pick*, which lets the dispatcher's classifier
  choose at dispatch time. Pick one explicitly only when you already know.
- **Builds on** — an optional parent ticket. See the dependency section below;
  this one does more than it looks like it does.

The surprise is that you can paste or drag **screenshots** straight into the
dialog. They are stored privately against the ticket and delivered to the
working agent as files it can actually look at, which is usually faster than
describing a broken layout in prose.

A new ticket lands in **Backlog**. Nothing dispatches from Backlog — that is the
resting state, and it is deliberate. Work starts when the ticket reaches Ready.

> [!NOTE]
> Every ticket gets a stable key like \`DevPilot-14\`, numbered per project and
> assigned once by the database. It never changes, even when you drag the card
> somewhere else. That key is the thing to quote when you talk about a ticket.

## The lifecycle

The board has ten columns. A ticket does not visit all of them, and the
interesting transitions are the ones that go backwards.

| Column | What it means | What moves it on |
|---|---|---|
| Backlog | Filed, not scheduled | You, or the backlog drain |
| Ready | Eligible to be picked up | The dispatcher |
| Assigned | Legal, but nothing in the engine uses it | You, by hand |
| In progress | An agent is working now | The agent, or its role's postprocess |
| Input required | The agent asked you a question | **You**, by commenting |
| Blocked | Parked for a human decision | You |
| Paused | You stopped it | You, by resuming |
| In review | Waiting on a reviewer's verdict | QA, by approving or rejecting |
| Done | The reviewer approved | — but the code still has to land |
| Failed | Out of retries, or a fatal error | — |

The happy path is short: **Backlog → Ready → In progress → In review → Done.**
Moving a card into Ready is the act that causes work; the dispatcher picks it
up, chooses a role, and moves it to In progress itself. \`Assigned\` exists in the
state machine and you can drag a card into it, but no engine path ever writes
it — the dispatcher goes straight from Ready to In progress.

The **In progress** and **In review** columns show a count against a soft limit
(3 and 5). That pill is a warning, not a gate: nothing refuses a move because a
column is busy.

### Why a reviewer can send work back

An engineer agent that finishes does not decide it is finished. It moves the
ticket to **In review**, and a reviewer role renders a verdict. An approval goes
to Done. A rejection sends the ticket back to **In progress** with the
reviewer's notes on the thread, and increments a retry counter — the engineer
picks it up again knowing exactly what failed.

That loop is bounded, and it has to be: two agents that simply disagree would
otherwise bounce a ticket between themselves indefinitely, on your budget. After
three rejections (\`DEVPILOT_QA_MAX_RETRIES\`, default 3) the dispatcher parks the
ticket in **Blocked** before choosing a role, so an exhausted ticket costs
nothing more, and posts a comment explaining the freeze.

> [!TIP]
> Moving a blocked ticket out of Blocked **resets** the retry budget — but only
> when a human does it. No agent or engine path can hand itself a fresh budget.
> So the recovery is: read the rejections, sharpen the acceptance criteria or
> make the change yourself, then move it back.

## Dependencies: what blocks, and what only refers

DevPilot stores every ticket-to-ticket relationship in one table with a type
discriminator, and **only two of the four types block anything**.

| Relation | Meaning | Blocks? |
|---|---|---|
| \`blocked_by\` | This ticket cannot start until that one is finished | **Yes** |
| \`builds_on\` | This ticket is stacked on that one's branch | **Yes** |
| \`related\` | A reference. "See also." | No |
| \`duplicate\` | A reference. "Same as." | No |

The drawer shows these as **Builds on**, **Built on by**, **Blocks**,
**Related** and **Duplicate**. A row reads in one direction: recording that A is
blocked by B is what puts B in A's blocker list and A in B's *Blocks* list.

![](figure:ticket-dependencies)

> [!WARNING]
> \`related\` never blocks, and that is load-bearing rather than cosmetic.
> Mentioning another ticket by its short id in a comment **auto-creates a
> \`related\` row**. When every relation blocked, mentioning a not-yet-finished
> ticket silently held the commenter's own ticket out of Ready, with nothing on
> the board explaining why.

### \`builds_on\` also decides where the branch is cut

\`blocked_by\` is only about ordering. \`builds_on\` is about *code*: it says the
child's work sits on top of the parent's, and the engine uses it to choose the
commit the child's branch starts from.

1. If the parent's work has **landed** on the integration branch, the child is
   cut from the integration branch at exactly the parent's landed commit —
   deterministic, and provably containing the parent's work.
2. If the parent has finished but **not** landed, the child is cut from the
   parent's own branch, because that is where the commits actually are.
3. If the parent **failed**, the child falls back to the integration tip. A
   dependency on an abandoned ticket would otherwise never resolve.

So use \`blocked_by\` for "do that first" and \`builds_on\` for "and build on top
of it". Getting this wrong is not fatal, but \`blocked_by\` will not give a child
its parent's code.

### What happens when you try to move a blocked ticket

Moving a ticket to Ready over an open blocker is refused, and the error names
the blockers. There is one deliberate exception: when every open blocker is
merely *waiting to land* — finished, approved, and queued for the integration
branch — **a human may override**. An agent may not. That distinction exists
because a finished-but-unlanded parent is visible on the board as finished, and
refusing your move over an engine detail would take away something you would
otherwise have.

## Watching the run

Once a ticket reaches In progress there is a real run behind it. Open it from
the card, or from **Runs**.

The inspector shows the run's steps as they arrive, with a **Waterfall** view
(where the time went) and a **List** view (what happened, in order). Each step
carries its elapsed time and its cost, and tool calls show what the agent
actually read, wrote or executed. If an agent captured browser screenshots
while working, they are attached to the step that captured them.

Steps accumulating is also the practical proof that a runner is connected — a
run that exists but never grows a step is a dispatch nothing has claimed. See
[Connect a runner](/guide/connect-a-runner) for what that looks like and how to
fix it.

## When the agent asks you something

An agent that hits a genuine decision it cannot make — which auth provider,
which of two acceptable behaviours you meant — does not guess and does not
stall. It posts the question as a comment and moves the ticket to **Input
required**. Nothing is left spinning while it waits — there is no held process
and no clock running against your budget.

![](figure:ticket-input-required)

**You resume it by replying on the ticket.** That is the whole mechanism, and it
is worth being precise about what happens:

1. Your comment lands on the thread.
2. The ticket moves back to **In progress**, recorded as a human action.
3. A **fresh dispatch** fires. The prompt is rebuilt from scratch, and the
   dispatcher's classifier reads the recent comment thread — including your
   reply — to pick the role that should carry on. Usually that is the same role
   that asked.

> [!NOTE]
> Because the prompt is rebuilt rather than a paused process being unfrozen, a
> reply works after five minutes or after three days. There is nothing to keep
> alive. The reply is deliberately surfaced to the next agent as its own framed
> block, so a long thread cannot bury it.

Commenting on a ticket in any *other* status does not restart anything — it is
just a comment. Input required is the one status where a reply is also a
trigger.

---

Once a ticket reaches Done, one more thing has to happen before its code is
anywhere you can use it. That is
[reviewing what the crew produced](/guide/reviewing-changes), and the gap
between "Done" and "landed" is the single most misread thing in DevPilot.

If your feature is bigger than one ticket, do not file ten by hand — describe it
once and let the crew break it down. See [Plan mode](/guide/plan-mode).
`;
