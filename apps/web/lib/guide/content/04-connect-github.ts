// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.
//
// The scope list and every "what it buys" line are read off
// `lib/github/scopes.ts` — `GITHUB_OAUTH_SCOPE_LIST` and
// `GITHUB_SCOPE_PURPOSE`, which that module exists to be the single source of.
// The three connection states, and the deliberate direction of failure on an
// unknown grant, are `adviseGithubConnection` in the same file. The push
// rejection quoted below is the one documented in its header.
//
// If a scope is ever added or removed, this section is one of the places that
// has to move with it — but `lib/github/scopes.ts` is the authority, not this
// prose.

export const CONNECT_GITHUB = `
DevPilot works on real repositories. Connecting GitHub is what lets an agent
clone one, commit to a branch and push it back — so this step decides what the
crew is able to do, and it is worth reading rather than clicking through.

You connect once, from **Settings → GitHub integration**.

## What DevPilot asks for, and what each one buys

Four scopes. The list is deliberately short and closed — every entry has to
justify itself, because permissions that accrete "while we're here" are how an
integration ends up able to do things nobody chose.

| Scope | What it buys |
|---|---|
| \`repo\` | Clone, commit and push to your private repositories |
| \`workflow\` | Create and edit GitHub Actions workflow files — without it, GitHub rejects any push that touches CI |
| \`read:user\` | Read your public profile, so the app can show who is connected |
| \`user:email\` | Attribute commits to you rather than to a generic bot |

The settings page lists the same four with the same explanations, so you can read
what you are about to grant on the screen where you grant it.

![](figure:github-scopes)

## \`workflow\` is not implied by \`repo\`

This is the one genuinely surprising thing about the permission model, and it
costs people an afternoon when they meet it the hard way.

\`repo\` grants full read and write access to your private repositories. It does
not grant the ability to change a file under \`.github/workflows/\`. GitHub treats
that as a separate capability and refuses the push outright:

\`\`\`text
! [remote rejected] (refusing to allow an OAuth App to create or update
  workflow '.github/workflows/ci.yml' without 'workflow' scope)
\`\`\`

The failure lands late and reads like a generic push error. Everything works —
the ticket is picked up, the code is written, the tests are run, the branch is
committed — and then the push is rejected at the very end. DevPilot's agents
routinely set up CI, so any ticket that adds or edits a workflow file is
permanently unlandable without this scope.

> [!WARNING]
> Be clear-eyed about what \`workflow\` grants. Anyone who can edit CI can cause
> CI to run arbitrary code, with whatever secrets that repository's Actions have
> access to. That is a real widening of what a leaked or misused token could do.
> It is requested because DevPilot's agents genuinely need it, not because it was
> convenient — and it is why the rest of the list is as small as it is.

## A scope change needs a fresh authorisation

GitHub never adds scopes to a token it has already issued. There is no upgrade
path and no background refresh: a connection authorised before a scope was
requested keeps working, keeps looking healthy, and keeps lacking that one
capability until you re-authorise it.

That means a scope change always has two halves — DevPilot asking for the new set,
and *you* reconnecting. Doing only the first changes nothing.

Reconnecting is the same button as connecting: it runs the same flow, requesting
the current scope set, and replaces the stored grant. Nothing else about your
projects is affected.

## What the settings page will tell you

Three states, because they need three different answers:

- **Not connected.** No grant at all. Connect GitHub.
- **Reconnect required.** The connection works, but its grant predates a scope
  DevPilot now needs. What is missing is a specific capability rather than the
  whole integration, so the page names the scope instead of telling you the
  connection is broken.
- **Connected.** Nothing is said at all. A banner that appears when everything is
  fine is a banner people stop reading.

> [!NOTE]
> There is a fourth situation, and it is reported honestly rather than guessed:
> when a stored grant records no scopes, DevPilot can prove neither that it has
> \`workflow\` nor that it lacks it. It asks you to reconnect anyway, and says it
> could not confirm. The two mistakes do not cost the same — a needless reconnect
> is one click, while wrongly staying quiet means your next CI ticket dies at
> push time, hours later, with a message that names none of this.

Next: [Create your first project](/guide/create-your-first-project).
`;
