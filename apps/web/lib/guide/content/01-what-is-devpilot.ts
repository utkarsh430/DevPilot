// Guide section body. Markdown in a template literal, NOT a `.md` file.
//
// This repo has expensive scar tissue around runtime file resolution: the header
// of `lib/export/fonts.server.ts` documents webpack silently rewriting a
// `createRequire` call into a throwing stub, so a font that sat perfectly
// readable on disk was "not found" in the built server and nothing at source
// level could see it. A static TS import has no resolution step and therefore no
// build-output-only failure mode: if this file is wrong, `pnpm typecheck` and
// `pnpm test` say so before the PR opens.

export const WHAT_IS_DEVPILOT = `
DevPilot looks like a Kanban board, and that is the first thing to unlearn. On
most boards a card is a *record* of work someone is doing elsewhere. Here the
card **is** the work: moving a ticket into Ready is what causes an agent to pick
it up, and the column a ticket sits in is the live state of a running job.

![](figure:board-orchestration)

## The board is the orchestration substrate

Agents do not talk to each other in memory. They hand work over the way a crew
does — by writing on the ticket and moving it. That has three consequences worth
holding on to.

1. Everything an agent did is visible after the fact, because it had to be
   written down to happen at all.
2. A run survives a restart, a crash, or a three-day wait for your reply. The
   engine holds the state, not a terminal you left open.
3. You can intervene anywhere. A comment is a first-class input, not a note.

A ticket moves through a fixed lifecycle. The interesting transitions are the
ones that go *backwards*:

| Status | What it means | Who moves it on |
|---|---|---|
| Backlog | Filed, not scheduled | You, or the drain |
| Ready | Eligible to be picked up | The dispatcher |
| In Progress | An agent is working now | The agent |
| Input Required | The agent is stuck on you | **You**, by commenting |
| In Review | Waiting on QA | QA, by approving or rejecting |
| Done | QA approved | — |

> [!NOTE]
> **Done is not the same as landed.** Done means QA approved the work. The
> commits reach your integration branch a moment later, and that step can fail on
> its own. A ticket's card tells you which of the two happened.

### Why QA can send work back

An engineer agent finishing a ticket does not decide it is finished. It moves the
ticket to In Review and a reviewer renders a verdict. A rejection sends the
ticket back to In Progress with the reviewer's notes attached, and the engineer
picks it up again knowing what failed.

That loop is bounded. Two agents that disagree would otherwise bounce a ticket
between themselves forever on your budget, so a retry ceiling parks the ticket
for a human once it is reached.

---

## What must be true before anything happens

Three things, and the third is where almost everyone gets stuck:

- A project, connected to a GitHub repository.
- A GitHub connection with the right scopes.
- **A runner that is alive.** Agent steps execute on a runner process. With no
  runner, tickets dispatch and then sit there.

> [!WARNING]
> "I moved a ticket to Ready and nothing happened" is the single most common
> first-run failure, and it is almost always a runner that is not running. See
> [Connect a runner](/guide/connect-a-runner).

You can check from a terminal:

\`\`\`bash
pnpm --filter @devpilot/runner dev
\`\`\`

> [!TIP]
> Agents write on tickets with a small set of tools. When you see a comment
> authored by \`devpilot_move_ticket\`, that is an agent recording a verdict — not
> a person. The [Claude Code documentation](https://docs.claude.com/en/docs/claude-code)
> covers the runner's underlying CLI.
`;
