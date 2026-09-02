// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.

export const PLAN_MODE = `
Filing tickets one at a time works until the thing you want is bigger than one
ticket. Plan mode is the other way in: describe the feature in prose, argue
about it with a lead until the scope is real, and let a panel turn it into an
ordered backlog with the dependencies already wired.

The output is ordinary tickets. Nothing about a committed plan is special
afterwards — the cards behave exactly like ones you filed by hand.

## Starting a plan

**Plan tickets…** on the board opens the planning sheet. It asks for three
things, only the first of which is required:

- **What are you building** — one paragraph is genuinely enough. The lead will
  clarify the rest.
- **Team tier** — how big a crew this plan is allowed to imagine. See below.
- **Preferences** — optional free text like *"Postgres OK, no AWS, prefer
  Vercel"*.

Press **Start planning** and the session opens in conversation.

### The four stages

A plan session moves through a fixed lifecycle, shown as a rail across the top
of the sheet.

| Stage | Session state | What is happening |
|---|---|---|
| Describe | (no session yet) | You are writing the opener |
| Refine | \`discussing\` | You and the lead are settling scope |
| Build | \`planning\` | The panel is drafting, then merging |
| Review | \`planned\` | You are editing the proposed tickets |

It ends **committed** or **discarded**, and either way the session is kept —
past plans are listed under Plans, and you can reopen one to read what was
decided.

## Refine: talking to the lead

In \`discussing\` you are in a normal chat with a planning lead. It pushes back,
asks about scope, and names the decisions it needs. Sometimes it replies with a
structured question panel instead of prose — up to four questions with suggested
answers — which you answer inline rather than writing them out.

This stage is the one worth spending time in. Beyond the project's own
description and stack, this transcript is the only thing the panel gets — so an
ambiguity you leave here becomes a ticket that guesses.

> [!TIP]
> If the project has a stack advisor recommendation you have not confirmed, this
> is the moment. The advisor never fires on its own — you press the button — and
> the services you confirm become a hard frame at the top of every planning
> prompt, so the panel stops inventing infrastructure you do not run.

## Build: three drafts and a merge

**Build plan** moves the session to \`planning\` and runs a panel. Three roles
each draft a complete ticket list independently, from the same discussion:

1. **PM** — scope, user-visible outcomes, acceptance criteria.
2. **Tech Lead** — architecture, sequencing, what has to exist first.
3. **DevOps** — deployment, CI, observability, the operational tail.

A fourth role, the **Consolidator**, then merges all three into one ordered
list. It deduplicates near-identical tickets, keeps the most precise acceptance
criteria where two drafts overlap, rewrites every dependency against its own new
ordering, and orders the result the way a single team would actually pick it up
— foundational work first, operational tickets last unless they unlock something
earlier.

The consolidator merges; it does not author. It is told not to invent tickets
that no draft proposed, so if something is missing from the plan it was missing
from the discussion.

> [!NOTE]
> You can close the sheet while the panel is running. The work is server-side
> and keeps going; reopen the sheet (or the project) to find it finished. If one
> panel fails or hangs, you can re-run just that lens — or just the consolidator
> — rather than paying for the whole build again.

### What the team tier changes

The tier is a real constraint on the panel, not a hint. It caps both the roles
the consolidator may assign and the number of tickets it may emit.

| Tier | Roles available | Ticket cap |
|---|---|---|
| Quick | PM, engineer, QA | 6 |
| Standard | 11 core roles — PM, tech lead, generalist/front/back/full engineers, QA, DevOps, security, designer, tech writer | 15 |
| Thorough | Every role in the catalog | 30 |

The roster cap is soft: a ticket the planner wanted to give to a specialist your
tier does not include is **rewritten** to the tier's generalist, with the
specialist's concerns folded into its acceptance criteria. A role outside the
allow-list is never a reason to reject a ticket.

The **ticket** cap is the harder edge. When the merged list is longer than the
cap, the consolidator is told to bundle related tickets together first, and only
then to drop the lowest-signal ones. So on a tight tier it is worth reading the
committed list against what you actually asked for — something may have been
merged away rather than merged in.

## Review: the part you should actually read

At \`planned\` the sheet shows the proposed tickets as an editable table. Every
field is yours: title, description, acceptance criteria, and the role. Untick
anything you do not want.

![](figure:plan-review)

Then commit with **Create all** or **Create selected**. What happens on commit
is worth knowing precisely:

1. The selected tickets are **topologically sorted** — dependencies before
   dependents — with the planner's own ordering as the tiebreak, so the
   narrative order survives wherever the graph allows it.
2. Real tickets are inserted, all in **Backlog**, positioned in that
   dependency order so the backlog reads top-to-bottom as the pickup order.
3. The plan's declared dependencies become real \`blocked_by\` relations between
   the new tickets.

> [!WARNING]
> When you commit **selected** rather than all, a dependency pointing at a ticket
> you did not create is silently dropped — there is nothing left to point at. If
> you are cherry-picking from a plan, check that you took the things the ones you
> kept depend on.

Nothing dispatches yet. The tickets sit in Backlog and you move them to Ready
when you want work to start, exactly as with a ticket you filed by hand — see
[your first ticket](/guide/your-first-ticket) for what that triggers.

## Why the scaffolder waits for the plan

This is the part that looks like a bug and is not.

When you create a project with a **new** repository, DevPilot files one
\`project_scaffolder\` ticket. Its job is to author the first commit of a
genuinely empty repository — pick the framework, lay out the directories, get a
build working. Project creation is the only thing in the entire system that
files a scaffolder ticket, and it files exactly one.

If you asked for a plan at the same time, two facts collide. The scaffolder
**must** run, or the repository stays empty forever. But the stack decisions it
is about to make are precisely what the planning discussion is about to settle.
Running it immediately produces a scaffold the plan then has to fight.

So the scaffolder is filed **held**: the card is in Backlog from the start, so
you can see the project's root work, but it is not dispatched. It is released
three ways, and one of them always happens:

- **You commit the plan.** The scaffolder is released carrying the session's
  confirmed stack and the discussion, so it scaffolds what you actually agreed
  on. The plan's root tickets are also wired to \`builds_on\` it, which is what
  makes every piece of feature work branch off the *seeded* repository rather
  than an empty one.
- **You discard the plan.** The scaffolder is released immediately with the
  plain project description. You said you were not planning it; there is nothing
  left to wait for.
- **You walk away.** A timer releases it anyway — 90 minutes by default
  (\`DEVPILOT_SCAFFOLDER_HOLD_TTL_MINUTES\`). An empty repository never stays
  empty because someone got distracted.

> [!NOTE]
> Dragging a held scaffolder into Ready is refused, for every actor including
> you, and the refusal says why and what to do instead. That looks strict, but a
> hand-promoted scaffolder and a plan release firing seconds apart would run the
> same ticket twice in one empty repository. Commit the plan or discard it — both
> release it immediately.

A plan can never file a second scaffolder. If the planner proposes a ticket with
that role, the role is stripped at commit and the ticket falls back to
auto-pick, so the work still happens under whoever the dispatcher chooses. A
project connected to an **existing** repository has no scaffolder at all, and
none of this applies.

---

Once plan tickets start reaching Done, their code still has to get onto your
integration branch. That is
[reviewing what the crew produced](/guide/reviewing-changes).
`;
