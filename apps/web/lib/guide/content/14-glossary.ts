// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.
//
// Every definition here was checked against USAGE, not against what the word
// usually means. The ones that surprised on checking, and must not be "tidied"
// back toward the intuitive reading:
//
//   • RUN is not "a ticket's work". Runs exist with no ticket at all —
//     supervisor children, the headless `/v1` surfaces, the widget, and
//     internal one-shot model calls that insert a row purely so their spend is
//     metered. `isSyntheticPlatformRun` (lib/metrics/agent-score.ts) exists
//     because those fictions once ranked #1 on the scoreboard.
//   • DISPATCH is a decision, not a queue push. `dispatchTicketFn` classifies
//     the role, picks an agent, creates the run row and moves the ticket
//     ready → in_progress BEFORE anything is offered to a runner.
//   • LANDING is a squash-merged per-ticket PULL REQUEST, server-side
//     (lib/github/client.ts explains why: no force-push onto a shared branch,
//     and GitHub hands back a stable merge sha).
//   • HANDOFF is scoped to BLOCKING ancestors (blocked_by / builds_on). An
//     @mention auto-creates a `related` row, and `related` must never carry
//     hand-off context or gate readiness — lib/board/dependencies.ts.
//   • A SKILL merges into the SYSTEM prompt; a LESSON is injected into the
//     TICKET prompt inside an untrusted fence. That split is deliberate and is
//     documented in lib/learning/select.ts — peer- and model-authored text is
//     data, and the system prompt is where trusted directives live.
//   • An OVERLAY never edits the shipped prompt. There is no column it could be
//     stored in; `agent_prompt_overlays` holds only the appended block.
//
// No figures: both captured figures are claimed by other sections and ids are
// globally unique across the guide.

export const GLOSSARY = `
DevPilot reuses some ordinary words with specific meanings. These are the ones
that carry more weight here than they look like they do, grouped by what they
are about.

## The work

| Term | What it means here |
|---|---|
| **Ticket** | The unit of work *and* the thing agents coordinate through. Not a record of work happening elsewhere — moving a ticket is what causes work to happen. Each carries a stable per-project key like \`DevPilot-14\`, assigned once and never rewritten. |
| **Dispatch** | The decision that turns a ready ticket into a run: pick the role, pick the agent, create the run, move the ticket to In Progress. It happens *before* any runner is involved, which is why a ticket leaves Ready even when nothing is there to work on it. |
| **Run** | One agent invocation, with its own budget, spend and status. Usually tied to a ticket, but not always — a supervisor's child, an API call and the embeddable widget all produce runs with no ticket at all. |
| **Step** | One checkpointed iteration inside a run: a model turn, a tool call, a tool result, a wait for a human, or an engine note. Steps are durable, so a run resumes at the step after a crash or a three-day pause rather than starting over. |

> [!NOTE]
> A run is not a terminal session. The engine holds the state, so closing the
> app, restarting the machine or waiting a week does not lose one.

## Where the code lives

| Term | What it means here |
|---|---|
| **Runner** | The process that actually executes steps — opens the repository, edits files, runs commands. The engine decides what should happen; the runner is what makes it happen. Nothing moves without one. |
| **Workspace** | A real git checkout on the runner's own machine, one per ticket (or per project for a preview). Because it is a real directory on one host, a run started on one machine cannot be resumed on another. |
| **Integration branch** | The shared branch completed work merges into — usually \`dev\`, and deliberately not your default branch. It is what a dependent ticket branches from once its parent has landed. |
| **Landing** | Putting a finished ticket's commits onto the integration branch: rebase onto the live tip, then a per-ticket pull request merged as a squash. **Distinct from Done.** Done means a reviewer approved; landing happens afterwards and can fail on its own. |

> [!WARNING]
> Done and landed are different facts and the board shows both. A ticket can be
> Done with its commits stranded — see
> [When something goes wrong](/guide/troubleshooting).

## How agents coordinate

| Term | What it means here |
|---|---|
| **Role** | What an agent is *for* — engineer, QA, product manager, security and about fifty others in all. The role decides the brief, the tools, and where a finished ticket goes next. |
| **Agent** | A configured worker in your workspace: a role, plus its model and settings. Roles are the catalogue; agents are your instances of them. |
| **Handoff** | A short note one agent leaves for the agents that come after it — what it built, a decision it made, an assumption it relied on, or an interface it defined. |

A hand-off is not a broadcast. It reaches only tickets **downstream** of the
author through a real blocking relationship, and it arrives labelled as claimed
rather than proven: the work it describes may still be in review, or may have
been rejected. Which relationship you used matters here and is easy to get
wrong:

- \`blocked_by\` and \`builds_on\` **block** readiness and carry hand-off context.
- \`related\` and \`duplicate\` are references only. They do neither.

> [!TIP]
> @mentioning another ticket creates a \`related\` link, not a blocking one. That
> is usually what you want — a mention should not quietly hold your ticket out
> of Ready.

## What shapes what an agent is told

Three things add to an agent's instructions, and they differ in who writes them,
where they land, and how much authority they carry.

| Term | Who writes it | Where it lands |
|---|---|---|
| **Skill** | DevPilot or you, installed per workspace | Merged into the role's system prompt at dispatch |
| **Overlay** | You, per role | Appended to the role's system prompt, below the contract |
| **Lesson** | Derived from recorded mistakes, then approved by you | Injected into the ticket prompt as data |

**A skill** is a reusable prompt fragment — a checklist, a convention, a
runbook. Skills are selected per ticket by role and by keyword, and only the top
few fire on any one dispatch, so a skill competes for a slot rather than simply
accumulating. Because a skill body becomes standing instructions, the
marketplace asks you to read one before installing it.

**An overlay** is your own standing addition to a role's brief — house rules,
in your words. It never edits the shipped prompt: the original stays in code,
untouched, and the overlay is an appended, clearly-fenced block beneath it. That
is why clearing an overlay is always a complete and correct reset, and why a
DevPilot update reaches you with your own additions intact.

**A lesson** is different in kind. DevPilot records concrete mistakes — a failed
run, a failing build, a review rejection, a correction you made — and drafts a
short lesson from each. By default nothing takes effect until you approve it in
the review queue; each draft is also graded for confidence, and you can opt into
letting the most confident ones through automatically. Approved lessons are
injected into the ticket prompt as *data*, inside a fence that tells the model
the role's own contract and your acceptance criteria outrank them.

> [!NOTE]
> The split is deliberate. A role's contract and your overlay are trusted
> instructions. A lesson drafted by a model from evidence an agent produced is
> not, so it is placed where it can inform without overriding.

## Two words that mean less than they sound like

**"Paused"** covers two very different controls. Pausing a *ticket* stops that
ticket and moves it to the Paused column. Pausing *automation* stops every
in-flight run in its scope and moves no ticket at all — and that scope can be a
whole workspace, not just one board.

**"Blocked"** is not only a dependency. It is also where the engine parks work
it has deliberately stopped: a review loop that stopped converging, a
safety-critical ticket awaiting your approval, a run stranded with nothing left
to revive it. Every one of those writes a comment saying which mechanism did it,
so the author on the comment is the fastest way to tell them apart.

If a term you met is not here, it is probably a comment author rather than a
concept — those are listed with their meanings in
[When something goes wrong](/guide/troubleshooting).
`;
