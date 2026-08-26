// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.
//
// Verified against code, not memory:
//   • Node `>=20` — root `package.json` `engines`. There is deliberately NO
//     `.nvmrc` in this repo; do not cite one.
//   • pnpm 10 — root `package.json` `packageManager: "pnpm@10.29.3"`.
//   • The runner's required env — `apps/runner/src/env.ts` `required(...)`:
//     UPSTASH_REDIS_REST_URL / _TOKEN, DEVPILOT_RUNNER_REGISTRATION_KEY,
//     DEVPILOT_RUNNER_TENANT_ID. `LOCAL_CC_CONCURRENCY` defaults to 2.
//   • The runner reads `apps/web/.env.local` — `apps/runner/package.json`
//     `dev: tsx watch --env-file=../web/.env.local`.
//   • The /setup redirect — `middleware.ts` `bootEnvPresent` guard.

export const BEFORE_YOU_START = `
DevPilot asks for less than you would expect, and one thing more than you would
expect. The short version: a GitHub account, a signed-in Claude CLI, and a
process running somewhere that is willing to do the work.

## What you need

| What | Why |
|---|---|
| A GitHub account | Projects are repositories. Agents clone, commit and push as you — see [Connect GitHub](/guide/connect-github) |
| The \`claude\` CLI, signed in | The default runner executes every agent step through it, on your own Claude subscription. It has to be installed and authenticated on whichever machine runs the runner |
| Node 20 or newer | The engine and the runner both run on it |
| pnpm 10 | The workspace is a pnpm monorepo; another package manager will not resolve it |

The last two are requirements of the DevPilot application itself, so they are
yours only if you are the one running it. If someone else operates your
instance, and runs the runner, the first two are all that concern you.

DevPilot keeps its own count of how far through this you are. The **Get started**
control in the topbar lists what is still outstanding and links straight to each
one, and it stops showing itself once all four are done.

![](figure:readiness-checklist)

> [!NOTE]
> The default runner uses your existing Claude subscription rather than an API
> key, so agent steps do not arrive as per-token charges. An API-key runner
> exists and is selectable, and it is what you need for multi-tenant serving —
> but you do not need it to start.

## What a runner is, and why one has to be alive

This is the concept worth understanding before anything else, because almost
every confusing first hour traces back to it.

DevPilot is two halves. The **engine** decides what should happen next and records
it durably — which role runs, in what order, with what budget, and what the
result was. The **runner** is a process that actually does it: it opens your
repository on a real filesystem, edits files, runs commands, and reports back.

The engine can do its entire job with no runner present. It will happily accept a
ticket, decide an engineer should pick it up, and queue that work. What it cannot
do is *perform* it. So an instance with no runner behaves exactly like a healthy
one right up until the moment work should start, and then quietly does nothing.

> [!WARNING]
> "I moved a ticket to Ready and nothing happened" is the most common first-run
> failure, and it is nearly always this. Nothing is broken and nothing is lost —
> the work is queued and waiting for something to claim it. Start a runner and it
> will be picked up. [Connect a runner](/guide/connect-a-runner) covers how, and
> how to tell it really connected.

A runner is tied to the machine it runs on. Workspaces are real directories on
that host, so runs cannot be moved between machines mid-flight. One runner
handles several steps at a time — the default is two concurrent steps, and one to
three is the sensible range for a subscription-backed runner. Starting more
runner *processes* does not buy more throughput from a single subscription; it
just multiplies the polling.

---

## Running DevPilot yourself

Skip this if someone else operates your instance.

A local install is four processes, and the order matters because each one depends
on the last:

1. **Supabase** — the database and auth. Everything else assumes it exists.
2. **The web app** — the engine and the UI. It also serves the durable-execution
   endpoint the next step talks to.
3. **The Inngest dev server** — consumes the durable events the web app emits.
4. **The runner** — executes the actual agent steps.

Miss the third and tickets dispatch but never progress. Miss the fourth and you
get the silent failure described above.

### First run: the setup wizard

You do not have to write a configuration file by hand. An instance with no
configuration redirects *every* route to a first-run wizard at \`/setup\`, which
collects the credentials it needs and writes them for you. Unlocking it takes a
one-time token printed to the server console at boot, so configuring an instance
needs access to the machine and not merely to the URL.

After that, credentials live in **Settings → Setup**, which walks each one with
live validation. The wizard turns itself off once the instance is configured, so
it cannot be used to reconfigure a running install.

> [!TIP]
> All configuration lives in **one** file, \`apps/web/.env.local\`. The runner has
> no environment file of its own — it reads the web app's. If you find yourself
> creating a second one, something has gone wrong.

The runner is the one component that needs credentials the wizard cannot guess:
a registration key and a tenant id that tell it which instance to join, plus the
Redis connection it polls for work. If it starts and immediately exits, it will
name the variable it is missing.

Next: [Connect GitHub](/guide/connect-github).
`;
