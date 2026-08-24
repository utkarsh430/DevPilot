// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.
//
// Verified against code:
//   • Both create flows — `app/(app)/projects/actions.ts`:
//     `createProjectFromExistingRepoAction` and `createProjectWithNewRepoAction`.
//     The new-repo flow passes `auto_init: false` (an EMPTY repo, on purpose)
//     and seeds `dev` off `main`; `auto_land_enabled` is armed ONLY when that
//     seed provably landed (`devReady`).
//   • Integration-branch resolution for a connected repo —
//     `lib/integration/connect-integration-branch.ts`: adopt `dev` when the repo
//     has none, else `devpilot-integration`, always cut from the default branch.
//   • Landing is a per-ticket PR merged with `merge_method: "squash"` —
//     `lib/github/client.ts` `squashMergePullRequest`.
//   • Platform values + `other` as the no-claim default —
//     `lib/projects/project-type.ts`.
//   • Team tiers and their ticket caps — `lib/team-tiers/tiers.ts`
//     (quick 6 / standard 15 / thorough 30).
//   • Document seeding — `lib/projects/doc-extract.ts`: md/markdown/txt/pdf/docx,
//     `MAX_UPLOAD_BYTES` 10 MB, and the file is parsed and discarded.

export const CREATE_YOUR_FIRST_PROJECT = `
A project is a GitHub repository plus the decisions DevPilot needs in order to
work on it: which branch agents land into, what kind of thing you are building,
and how large a crew to plan for. You can change all of it later; picking
something sensible now mostly saves you from re-explaining it to a planner.

There are two ways in, and they differ in more than convenience.

## Connect an existing repository

Paste a \`github.com\` URL. The project name is derived from the repo, and you can
edit it.

The one thing worth watching is the **integration branch** — the shared branch
every ticket is cut from and merged back into. DevPilot resolves it without ever
repurposing a branch that already means something to you:

- If the repository has no \`dev\` branch, DevPilot adopts \`dev\`, created from your
  default branch. The name is conventional and, when it does not exist yet, it
  carries no prior meaning.
- If \`dev\` already exists, it is yours. DevPilot leaves it alone and creates
  \`devpilot-integration\` instead, again from your default branch.

Either way your default branch is untouched.

> [!WARNING]
> If GitHub cannot be reached to create that branch, the project is still
> created — but with **no integration branch at all**, which is worth knowing
> because of what it implies: agents then push straight against your production
> branch, with no staging buffer in between. The project's Branch routing card
> says so and lets you set one by hand. Do that before you run a ticket.

## Create a new repository

DevPilot creates the repository **empty**, with no README and no initial commit,
and that is deliberate rather than an oversight. The first commit is written by
the project scaffolder agent, which wants an unborn branch to seed rather than a
fight with a file GitHub generated.

It then creates \`dev\` from \`main\` so that the first ticket has somewhere to
branch from. Automatic landing is armed only if that branch really appeared on
the remote — arming it against a branch that failed to seed would wedge every
subsequent landing, so a failure leaves the project visibly half-configured
instead of silently broken.

> [!NOTE]
> An empty repository is the *point* of this flow, not a state to fix. If you
> look at it on GitHub before the scaffolder has run and find nothing there,
> nothing has gone wrong.

## The integration branch, and what landing does with it

Once a project has an integration branch, the cycle for a code ticket is:

1. The ticket's branch is cut from the integration branch.
2. The agent commits to that branch and pushes it.
3. When the ticket reaches Done, DevPilot opens a pull request from it into the
   integration branch and merges it with a squash.
4. Promoting the integration branch to your production branch stays yours.

That last line is the important one. With an integration branch configured — which
both create flows set up for you whenever GitHub is reachable — DevPilot lands into
a branch it manages and never into your production branch, so shipping stays a
decision you make.

The project's **Branch routing** card is where the two live, and where you change
which branch counts as which.

![](figure:integration-branch)

> [!WARNING]
> **Done is not landed.** Done means the reviewer approved the work. The commits
> reach your integration branch a moment later, in a separate step that can fail
> on its own — a conflict, a rejected push, a missing permission. A ticket's card
> tells you which of the two actually happened, and it is worth believing the
> card rather than the column.

## Platform, crew size and stack

Three choices on the create form. None of them lock anything down; all three are
frames that stop a planner proposing work for a product you are not building.

**Platform** is what you are targeting: web, mobile, iOS, desktop — or *other*,
which is the default and means "no claim". It steers the command used to run a
preview of your app, and it goes into every planning prompt as a hard frame, so a
planner does not propose browser routes for an iOS app. Leaving it at *other*
constrains nothing.

**Team tier** decides how large a crew a plan is allowed to assume, and it is the
setting with the most visible effect on cost:

| Tier | Crew | Ticket cap per plan |
|---|---|---|
| Quick | PM, one engineer wearing every hat, QA | 6 |
| Standard | Core specialists — PM, tech lead, front/back/full engineers, QA, devops, security, designer, tech writer | 15 |
| Thorough | Every role in the catalogue | 30 |

Quick does not do less work; it packs the same work into fewer tickets and fewer
handoffs. Thorough splits along role boundaries so specialists can review each
other. Standard is the default.

**Stack** is two related things. An *ecosystem* — AWS, Azure, GCP, open source,
mixed, or unset — says which world you want to stay inside. Individual *service
tags* pin the specific services you have already committed to, and they are
rendered into planning prompts as a strong preference: the planner should propose
your Postgres rather than inventing a different database. It is a preference, not
a ban — a genuinely better option can still be proposed, but it has to say so
rather than substitute silently.

When you connect an existing repository, DevPilot reads its manifests and
pre-ticks the services it recognises. Those are suggestions until you submit the
form; **you** confirming them is what makes them a decision.

---

## Seeding from a document

If you already have a spec, a PRD, or a page of notes, the *Create new* tab will
read it and fill the form in. Markdown, plain text, PDF and \`.docx\` are accepted,
up to 10 MB.

What comes back is a proposed name, description and a longer detail block, all
editable. Read them before you submit — that review is the whole safety mechanism
here, because the document's text is not something DevPilot can vouch for.

> [!TIP]
> The file is parsed and thrown away. It is never stored, so uploading a document
> is not a decision about where that document now lives.

Two failure modes, deliberately handled differently. A file DevPilot cannot read
at all — an unsupported type, an empty file, one over the size limit — is
refused, and you are told why. A file it reads but cannot *summarise* — because
no runner is available yet, which on a fresh install is likely — degrades to the
raw extracted text in the description rather than blocking you from creating the
project.

Finally, the plan toggle. With **Generate a structured plan** on, a planning
session starts alongside the project: you refine the plan in a chat, then commit
it and it becomes your backlog. With it off, the scaffolder reads your
description as written and gets on with it.

Next: [Connect a runner](/guide/connect-a-runner), without which none of the
above will actually start.
`;
