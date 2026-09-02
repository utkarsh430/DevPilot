// Guide section body. See the header of `01-what-is-devpilot.ts` for why these
// are template literals in `.ts` rather than `.md` files.
//
// ACCURACY NOTE for whoever edits this next. The secrets section is the one
// people state BACKWARDS, and getting it backwards is a security claim, not a
// wording slip. The facts, each traced to the code:
//
//   • PROJECT secrets DO reach the agent. `run-agent.ts` loads them at dispatch
//     (`loadProjectSecretsJson`) and the runner both writes them to a 0600
//     `<workspace>/.env.local` AND merges them into the `claude -p` env
//     (`apps/runner/src/index.ts`, `buildSubscriptionEnvOverrides`).
//   • PLATFORM secrets do NOT, except per-key opt-in. The flag is
//     `shareWithAgents` in `lib/platform-secrets/catalog.ts`, default absent,
//     settable only in code. Today exactly one key carries it: VERCEL_TOKEN.
//     `lib/platform-secrets/agent-shared.ts` is the whole rule and its header
//     explains why a blanket "fall back to platform level" was refused.
//   • Six names never reach the agent PROCESS however they are stored:
//     SUBSCRIPTION_BLOCKED_ENV_KEYS in `apps/runner/src/subscription-env.ts`.
//     They still reach the workspace `.env.local`, which is a different
//     consumer with a different trust story (the project's own app).
//
// If you widen any of those three sentences, re-read those files first.

export const SETTINGS = `
Most of DevPilot runs on defaults. This is the short list of settings that
actually change what happens, and the one distinction it is worth being precise
about: which of your stored credentials an agent can read.

Settings live at **Settings**, which carries ten tabs. Four of them — Setup,
Appearance, Notifications and Agent preferences — do what their names say and
need no explanation here. The rest are below.

## LLM auth: which credential runs your agents

**Settings → LLM auth** picks how DevPilot authenticates to Claude for every
agent run. There are exactly two modes and the choice is per workspace.

| Mode | What it uses | When you want it |
|---|---|---|
| **Claude Code subscription** *(default)* | Your own Claude Pro/Max subscription, through the local runner | A single operator. No API key, no per-token bill. |
| **Anthropic API key** | A per-token \`ANTHROPIC_API_KEY\` | Multi-tenant or per-token serving |

The default is the subscription path, and it is the default in a strong sense:
anything unrecognised in storage resolves back to it, so a fresh install and a
half-configured one behave the same.

![](figure:settings-llm-auth)

> [!NOTE]
> Switching to the API-key mode does not remove the need for a runner. The
> runner is what opens your repository and runs commands; the auth mode only
> decides which credential pays for the model. See
> [Connect a runner](/guide/connect-a-runner).

### Provider is a different question, and it is per project

Auth mode answers *which credential*. **Provider** answers *which endpoint*, and
it is set on the **project's own page**, not in Settings. A project can be left
on inherit (the normal case), pinned to Anthropic, or pointed at an
OpenAI-compatible endpoint of your own.

Resolution runs project » workspace » instance » environment, so a project that
has never been touched follows the workspace default and changes nothing.

> [!WARNING]
> An OpenAI-compatible project never uses the local runner. The default runner
> *is* the \`claude\` CLI and speaks Anthropic only, so those projects are routed
> to the API path instead. Everything on that path that depends on a real
> workspace — the hand-off build check, a committed branch — is unavailable
> there.

The API key for a custom endpoint is write-only from that card: DevPilot records
whether one is configured and never reads the value back.

---

## Secrets: project vs platform, and which an agent can read

There are two separate stores, they live in different places, and they have
opposite defaults about agent access. This is the part worth reading twice.

| | **Project secrets** | **Platform secrets** |
|---|---|---|
| Where | The project's own page | **Settings → Platform secrets** |
| Scope | One project | The whole account |
| Holds | That app's own config — database URL, third-party keys | DevPilot's own plumbing — Supabase, Redis, Stripe, Inngest, tracing |
| Reaches an agent? | **Yes, by default** | **No, except per-key opt-in** |

### Project secrets reach the agent. That is the point of them.

At dispatch, a project's secrets are handed to the runner, which does two
things with them: it writes a \`.env.local\` in the workspace (owner-read-only)
so \`pnpm dev\` and \`pnpm build\` see them natively, and it merges them into the
agent's own process environment so tools that read \`process.env\` see them too.

That is deliberate — an agent building your app needs your app's config. Treat
anything you put there as readable by the agent working that project.

### Platform secrets do not, unless a key is explicitly flagged in code

A blanket "not set on the project, so read the account-wide one" fallback was
considered and refused. Platform secrets hold the credentials DevPilot itself
runs on; a general fallback would place every one of them into every agent's
environment on every dispatch, permanently.

So sharing is **per key, off by default, and set in code rather than by a
toggle** — widening what agents can read should require a diff and a review.
Today exactly one key is shared: the Vercel API token, because it identifies
*you* rather than any one app and would otherwise have to be pasted into every
project's vault by hand.

The rule that decides membership is worth knowing if you ever add another:
shareable if the credential identifies the **operator**, project-scoped if it
identifies the **app**. The Supabase keys are excluded under exactly that rule —
each project has its own database, so a fallback there would silently hand a
project the wrong one instead of failing cleanly.

> [!TIP]
> You do not have to trust this page for it. The Platform secrets tab badges
> every shared key inline, from the same rule the dispatch path uses, so "which
> of my credentials are exposed to autonomous agents" is answerable by looking
> at the screen.

![](figure:platform-secret-shared)

### Six names never reach an agent, however you store them

The local runner is the subscription path by definition. If an Anthropic API key
reached it, the CLI would silently switch to pay-per-token and ignore your
subscription — and a redirected base URL would send the agent's entire
conversation somewhere of the writer's choosing.

So these six are stripped from the agent's process environment regardless of
which store they came from:

- \`ANTHROPIC_API_KEY\`, \`ANTHROPIC_AUTH_TOKEN\`, \`ANTHROPIC_BASE_URL\`
- \`DEVPILOT_LLM_API_KEY\`, \`LLM_PROVIDER_API_KEY\`, \`LLM_PROVIDER_BASE_URL\`

A project secret by one of those names still reaches the workspace
\`.env.local\` — that is your app's config file, a different consumer with a
different trust story — so an app that genuinely needs an OpenAI key keeps
working. What it cannot do is reach the agent process.

### Overrides and who may write them

A platform secret resolves tenant override » instance » environment, so a
workspace value wins for that workspace and the environment file is the fallback
of last resort. Some keys are restricted to an instance operator for **both**
setting and deleting — deleting an override silently reverts the whole workspace
to a different credential, which is the same capability as setting one.

---

## API keys

**Settings → API keys** issues tokens for reaching DevPilot from outside the app.
Two scopes:

- **api** — the full agent surface.
- **widget** — scoped to a single agent, for the embeddable widget at
  \`/widget/<agentId>\`. It cannot call the full surface.

The secret is shown **once**, at creation. DevPilot stores a hash and a short
prefix, never the cleartext, so there is no "show me that key again" — if you
lose it, revoke and issue another. The list shows the prefix, the scope and when
the key was last used, which is enough to tell a live key from a forgotten one.

## Billing

**Settings → Billing** shows your balance, the monthly included credit, current
overage, and the most recent billed runs. Overage bills at the underlying model
spend plus a markup (20% by default).

Card management happens in Stripe, not here — the page hands you off to the
Stripe portal. The one behaviour worth knowing in advance is what happens when
the balance goes negative without a valid card: dispatch is **refused**, and the
refusal is written onto the ticket as a comment naming the balance and pointing
at this page. It is not silent, and it is not a crash.

## System health

**Settings → System health** is the deep-dive behind the topbar dot. It probes
seven services — the local runner, dev servers, the database, the cache/queue,
durable execution, the LLM path and tracing — and shows each one's state,
latency and a one-line detail.

Two properties make it worth opening rather than guessing:

1. Some services are marked **optional** and are excluded from the overall
   rollup, so a missing tracing key never reds out an otherwise healthy system.
2. A non-healthy service carries a **Fix** link straight to the step of the
   setup wizard that configures it.

The runner card is the one you will read most often, and its detail line is
specific: *"no runner has registered"* means one has never connected at all,
while *"offline · last beat 6m ago"* means one did and then stopped. Those are
different problems — see
[When something goes wrong](/guide/troubleshooting).

## Exports

DevPilot produces three PDFs, and they are not in Settings — they are where the
thing being exported lives.

| Export | Where | Shape |
|---|---|---|
| **Ticket audit** | The ticket drawer, *Export PDF* | Built on the spot |
| **Project audit** | The board / project menu | A background job, then a download |
| **This manual** | The guide | A cached static download |

A ticket audit carries the full thread, the narration of every run, cost, and
the evidence behind each verdict. The project audit is the same treatment across
a board, with full detail for up to 30 tickets and summaries beyond that — and
it says so in the document rather than quietly truncating.

> [!NOTE]
> One number in an audit PDF deserves care: if any model turn could not be
> priced, the whole cost rollup is flagged as such rather than presented as
> exact. A self-hosted endpoint is not free just because DevPilot has no price
> table for it.
`;
