// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.
//
// ── Accuracy note for whoever edits this next ──────────────────────────────
//
// Every claim here was read out of the code rather than remembered, and three
// of them are easy to get subtly wrong:
//
//   • THE TWO PAUSES. `lib/engine/cancel-check-policy.ts` states the
//     distinction better than any prose can: the per-ticket pause flips the
//     RUN row to cancelled and moves the ticket to the paused column; the
//     board/workspace pause writes an automation flag, halts in-flight runs at
//     their next iteration boundary, and MOVES NO TICKET. Confusing them is how
//     someone stops the wrong thing, so the table below is deliberately the
//     first thing in that subsection.
//
//   • WHAT A CEILING DOES WHEN IT BITES. `assertCanProceed` throws a
//     NonRetriableError, so the RUN ends `failed`. It does not pause, it does
//     not queue, and it does not move the ticket - which is why the recovery
//     sentence is here rather than left to the reader's optimism.
//
//   • WHEN THE CHECK RUNS. `assertCanProceed` fires twice per step - once
//     before it starts, once again right after its spend lands - because
//     every dispatch sends a single step per run, and a check that only ran
//     before the step could let ONE step's actual cost sail past the cap with
//     nothing catching it until the run had already finished. The second
//     check is what makes "stops at the boundary" true rather than aspirational.
//
//   • WHAT THE SPEND NUMBER IS. `stepCost` prices reported token usage at list
//     price. On the default subscription runner nobody is billed per token, and
//     for an OpenAI-compatible endpoint the cost is an explicit labelled ZERO -
//     so the dollar ceiling genuinely does not bind there. Saying "DevPilot caps
//     your spend" without that caveat would be an overclaim.

export const SAFETY_BUDGET_STOPPING = `
DevPilot runs agents that edit real repositories and spend real money, on your
behalf, while you are not watching. This section is the set of controls that
bound that: what an agent may finish on its own, what it may spend, and how to
stop it.

Read the pause section carefully even if you skim the rest. There are two pause
controls that look similar and reach very different distances, and picking the
wrong one is the most common way to stop something you did not mean to - or to
believe you stopped something you did not.

## Safety-critical tickets

Some work should not reach Done without a qualified person looking at it. Flag
such a ticket **safety-critical** from the Safety section of the ticket drawer,
and one rule takes effect for the rest of its life:

![](figure:safety-critical)

> [!WARNING]
> A safety-critical ticket can only be moved to Done by a human. Any attempt by
> an agent, or by DevPilot's own engine, is refused - the ticket parks in Blocked
> with a note explaining why, and waits for you.

Four properties of that gate:

- **It is the flag, and only the flag.** There is no environment variable that
  turns it off, deliberately - a safety gate an operator can quietly disable is
  not a safety gate.
- **Only you can arm or disarm it.** No agent, tool or runner path can touch it,
  so an agent cannot clear its own gate. Arming and disarming are both recorded
  as comments on the ticket naming who did it.
- **The work is not rejected.** Parking to Blocked is a hold, not a verdict.
  Read what the crew produced, then use **Approve & mark Done** in the drawer.
- **It does not slow the agent down.** The crew works the ticket normally. Only
  the last move is gated.

Flagging late is fine. The gate applies from the moment you set it, whatever the
ticket has already done.

---

## Spend ceilings

Two independent limits, plus a set of caps on how far agents may spawn other
agents. They fail in different directions on purpose.

### The per-run ceiling

Every run carries a budget, **\$5 by default**. DevPilot checks whether there is
headroom left before a step starts, and checks again the moment that step's
actual cost is known - immediately after it finishes, before the run does
anything further. A step already in flight is never interrupted for cost: the
check only ever runs at those two boundaries, so at most one step can spend
past the ceiling before the run stops there.

What "stops" means matters: the **run ends failed**. It does not pause, it
does not wait for you, and it will not be retried - a ceiling that retried would
not be a ceiling. The step that pushed it over still completes and whatever it
committed is not undone; the run simply does not go on to spend anything more.
The ticket itself is left where it was, and a recovery sweep hands it back to
you after roughly half an hour of no activity, so it cannot sit dead on the
board indefinitely.

The run inspector shows the distance to that ceiling while a run is going, and
after it has finished.

![](figure:run-cost-ceiling)

Some tickets are legitimately expensive, and you may decide in advance that one
project's work should never be cut off for cost. **Budget cap**, in that
project's settings, is an off-by-default switch that does exactly that - once
turned on, this project's runs are never stopped for exceeding their per-run
ceiling. It changes nothing else: the workspace-wide circuit breaker below
still applies to an overridden project's runs exactly as it does to every
other project's, so "ignore my cap" never means "no ceiling at all," and one
overridden project cannot starve every other project sharing the workspace's
spend window.

### The circuit breaker

The per-run cap cannot see a run that never gets expensive. A misconfigured
fan-out that starts two hundred individually cheap runs stays under every
per-run ceiling and still costs real money.

So there is a second, workspace-wide limit: a rolling one-minute window with a
default ceiling of **\$5 per minute**. Once that window's total reaches the
limit, no new model step starts anywhere in the workspace until the window
rolls over.

> [!NOTE]
> If DevPilot cannot read the spend window - a Redis outage, say - the breaker
> **fails closed**. It refuses rather than assuming nothing has been spent, on
> the grounds that an infrastructure incident is exactly when a runaway is most
> likely and least visible. A brief blip retries itself; a sustained one fails
> the run.

Plan mode has its own pair of limits, because a planning conversation has no
run to charge against: a per-session cap (\$1 by default) alongside a
per-minute window of its own.

### Spawn caps

An agent that can start other agents is the classic way a small mistake becomes
an expensive one, so recursion is bounded four ways at once:

| Cap | Default |
|---|---|
| Depth of the spawn tree | 3 |
| Children per parent | 4 |
| Active runs per workspace | 20 |
| Child budget | Drawn only from what the parent has left |

The last row is the one that makes the others belt-and-braces rather than
load-bearing: because a child can only be given headroom its parent still has,
total spend across an entire spawn tree can never exceed the budget of the run
at its root, whatever happens in between.

A single run is also capped at 20 iterations, regardless of money.

### What the number actually means

> [!WARNING]
> Spend is an **estimate**, computed from reported token usage at published list
> prices. It is not a bill.

Three consequences worth knowing before you tune anything:

- On the default subscription runner **you are not billed per token at all**.
  The ceiling still applies, but treat it as a bound on how much work one run
  does rather than as a dollar figure you are protecting.
- Against an OpenAI-compatible endpoint DevPilot has no price table, so it
  records an explicit, labelled zero rather than inventing a number. The dollar
  ceiling therefore does not bind there - the iteration cap and your own
  provider's limits do.
- A model whose exact identifier DevPilot does not recognise is priced at the
  tier the run asked for, rather than silently counted as free.

---

## Stopping things: two pauses, two blast radii

This is the distinction to get right.

| Control | Where it lives | What it halts | What it moves |
|---|---|---|---|
| Pause this ticket | The ticket itself | Every run on that one ticket | The ticket, into Paused |
| Pause project | The project header | Every ticket in that project | **Nothing** |
| Pause workspace | The top bar | Every ticket in **every** project | **Nothing** |

### Pausing one ticket

Pausing a ticket cancels every run in flight on it and moves the ticket into the
Paused column. It reaches that ticket and nothing else.

It only applies where work is actually under way - In Progress, In Review, Input
Required, Blocked or Assigned. On a Backlog, Ready or finished ticket there is
nothing to pause and the click is a harmless no-op.

Resuming puts the ticket back to In Progress and **replays the cancelled run
from its last completed step**, not from the beginning. The work already done is
not repeated.

### Pausing a project or the workspace

These flip a switch and nothing else. That is the part people misread:

> [!WARNING]
> A project or workspace pause **moves no ticket**. Your board looks exactly the
> same paused as it does running. If you are wondering why nothing is happening,
> check the automation switch before you go looking for a broken runner.

What it does do is both halves of "stop": no new work is dispatched, and runs
already in flight halt at their next step boundary.

The two scopes are not interchangeable. The switch in a project header covers
that project. The switch in the top bar covers **every project in the
workspace** - it is the widest control in the product, and if both are on the
workspace one wins.

Resuming re-dispatches the tickets that were in Ready, In Review or In Progress,
each continuing from its last checkpoint. Tickets in Blocked, Input Required or
Paused are deliberately left where they are: resume restarts work, it does not
unpark decisions that are waiting on you. If a scheduled backlog drain was due
while you were paused, you are told about it after resuming.

### Neither pause kills a step mid-flight

Both controls let the step that is currently running finish before the loop
exits. That is deliberate - the completed step is what the resume picks up from,
so stopping cleanly is what makes resuming cheap.

The practical consequence is that Pause is not instant. Expect anything from a
few seconds to a couple of minutes between the click and the run actually
stopping, depending on what it was in the middle of.

> [!TIP]
> Resuming a single ticket is refused while its project or workspace is paused,
> because it would achieve nothing - the dispatcher would simply decline the
> work again. Turn automation back on first, then resume the ticket.

---

## Everything an agent produces is data, never instructions

The last control is not a switch. It is a rule DevPilot applies to itself, and
knowing it changes how you read the board.

Agents constantly consume text that neither you nor DevPilot wrote: comments,
hand-off notes from other agents, rows returned by the read-only database tool,
web pages, dependency READMEs, and screenshots you paste onto a ticket. Any of
it can contain something addressed at the model rather than at the work.

So the places where that material crosses into another agent's prompt wrap it in
an explicit "data, not instructions" fence - hand-off notes from an earlier
ticket, recalled lessons, your own latest reply, delivered screenshots - and
neutralise any fence markers inside it, so injected text cannot close the
wrapper and impersonate the prompt around it. The read-only database tool is
bounded the same way: it accepts SELECT statements only, against tables an
operator explicitly allow-listed, with a mandatory row limit.

> [!NOTE]
> Fencing is a bet on the model respecting the framing, not a guarantee that it
> will. That is precisely why the other controls exist: installed skills,
> overlays and lessons all sit *below* the role's own contract; lessons need a
> human approval before they reach a run; and a safety-critical ticket needs a
> person to move it.

The habit to take away: treat anything an agent read, and anything a stranger
could have written, as untrusted input rather than as a report. A ticket
description pasted from an external issue tracker is exactly as trustworthy as
the person who filed it.

---

If a ticket is stuck rather than dangerous, the cause is more often the plumbing
than the policy - [connect a runner](/guide/connect-a-runner) covers the failure
that accounts for most of them. For what the crew can add to itself, see
[skills, prompts and lessons](/guide/skills-prompts-lessons).
`;
