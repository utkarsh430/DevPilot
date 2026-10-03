# infra/ — Phase 0 always-on host setup

## Local dev dependencies (`infra/local/`)

`infra/local/docker-compose.yml` runs the local stand-in for Upstash Redis - a plain Redis
behind an Upstash-compatible REST front, bound to `127.0.0.1:8079` with a fixed, local-only
token. `pnpm setup:local` and `pnpm dev:local` start it for you; by hand:

```bash
docker compose -f infra/local/docker-compose.yml up -d      # start
docker compose -f infra/local/docker-compose.yml down -v    # stop and wipe the queue
```

It is for local development only (loopback-bound, published token); a real deployment points
`UPSTASH_REDIS_REST_URL`/`_TOKEN` at an Upstash database.

---

The Local Claude Code Runner has to **stay up between sessions** for DevPilot to deliver on the "agents drive tickets to done while you're logged off" promise (design rule: long-running autonomy is a server-side property, never a terminal). `tmux` and ad-hoc `&` do not qualify.

Phase 0 ships two equivalent templates:

| Host OS | Path                                      | Manager                                          |
| ------- | ----------------------------------------- | ------------------------------------------------ |
| macOS   | `infra/launchd/com.devpilot.runner.plist` | `launchd` (per-user LaunchAgent)                 |
| Linux   | `infra/systemd/devpilot-runner.service`   | `systemd --user` (with `loginctl enable-linger`) |

Both auto-start at login/boot, auto-restart on crash, write to `~/.devpilot/logs/runner.{out,err}.log`, and run the same command as `pnpm dev` would: `pnpm exec tsx --env-file=../web/.env.local src/index.ts` from `apps/runner/`.

## Install

**macOS** (paths auto-resolved at install time — the committed plist is a host-neutral template with `__DEVPILOT_RUNNER_DIR__` / `__HOME__` tokens that `install.sh` renders from its own location, so no editing is needed wherever you clone):

```bash
bash infra/launchd/install.sh
```

**Linux** (assumes clone at `~/code/devpilot/` — edit `WorkingDirectory=%h/...` in the unit if not):

```bash
bash infra/systemd/install.sh
```

Both installers are idempotent — re-run after editing the template.

> **Upgrading from ACE?** The service was renamed with the product: `com.ace.runner` → `com.devpilot.runner` (macOS) and `ace-runner.service` → `devpilot-runner.service` (Linux).
> On a host that still runs the old unit, remove it first so you don't end up with two runners: `launchctl bootout gui/$(id -u)/com.ace.runner` on macOS, or `systemctl --user disable --now ace-runner.service && rm ~/.config/systemd/user/ace-runner.service` on Linux, then run the installer above.
> Log paths moved too: `~/.ace/logs/` → `~/.devpilot/logs/`. Old logs are left where they are; the new unit writes to the new path. If you also want the runner's workspaces under `~/.devpilot`, see "Workspaces" below - that move is deliberate and separate, because a workspace can hold the only copy of an unpushed commit.

## Workspaces

The runner clones each ticket into `WORKSPACE_ROOT` (`apps/web/.env.local`), defaulting to
`~/.devpilot/workspaces`. A host that ran the pre-rename default has real clones under
`~/.ace/workspaces`, and some of them may hold commits that exist nowhere else. **Do not let the
default silently repoint them**: pin `WORKSPACE_ROOT=$HOME/.ace/workspaces` and keep using them,
or move the directory deliberately (`mv ~/.ace ~/.devpilot`) on a quiet system once every workspace
is pushed, then drop the pin.

## Verify

See `infra/launchd/SMOKE.md` or `infra/systemd/SMOKE.md`. The one liner that proves the engine handshake worked, on either OS:

```bash
grep 'registered:' ~/.devpilot/logs/runner.out.log | tail -1
# → [devpilot-runner] registered: <uuid>
```

## Uninstall

```bash
bash infra/launchd/uninstall.sh    # macOS
bash infra/systemd/uninstall.sh    # Linux
```

Both preserve the log directory.

---

## Phase 0 dress rehearsal (M9 acceptance)

The exit criterion for Phase 0 (PRD §9) is the **password-reset scenario, fully autonomous, with the operator logged off**. The runner under launchd/systemd is what makes "logged off" real.

Run this on a host with the runner installed and the engine (Next.js + Inngest) reachable — Vercel for the engine if you've deployed it, or a port-forwarded local dev box.

1. **Start state.** Confirm the runner is `running`, the engine is up, Inngest is connected.
   ```bash
   grep 'registered:' ~/.devpilot/logs/runner.out.log | tail -1
   curl -sf https://<your-engine>/health
   ```
2. **File the ticket.** From `/board`, click **+ New ticket**: title `add password reset`, description `users want a way to reset their password if they forget it`. Drag it from `backlog` to `ready`.
3. **Leave.** Close the laptop lid (macOS) or `pkill -9 -u "$USER" -f firefox` (browser closed). On a remote host, you can also `ssh` out entirely — the runner survives because launchd/systemd own it.
4. **Wait 30 minutes** (or whatever the configured budget allows; the headline scenario runs ~2.5 minutes when warm).
5. **Reopen.** Visit `/board`. The ticket should be `done` (or mid-flight). Open the drawer → confirm the comment trail shows **PM → Engineer → QA REJECT → Engineer → QA APPROVE**.
6. **Open the run inspector** for each of the 5 runs (`/runs/<id>` from the drawer's Runs section). Each step's `created_at` should be continuous — no gap longer than what the LLM call took. The QA REJECT step shows the amber badge; APPROVE shows green.
7. **Open Langfuse.** The trace tree mirrors the step tree, every generation has tokens + cost, no orphan spans.
8. **Crash test.** `pkill -9 -f 'tsx --env-file=../web/.env.local'`. The runner respawns within `ThrottleInterval` (macOS) / `RestartSec` (Linux). If you kill it mid-run, the durable engine retries the in-flight `step.waitForEvent` once the new runner registers.

If 1–8 all hold, M9 / Phase 0 is done.

---

## Deploying the engine (Vercel)

The runner runs on your always-on host; the engine (Next.js + Inngest + Supabase + Upstash) is what the runner talks to. For a real "logged off" test you typically push the engine to Vercel so the runner doesn't depend on `localhost:3000` being up.

Outline (operator-side — not scripted here):

1. `vercel link` and `vercel env pull` against this repo's `apps/web`.
2. Add all `apps/web/.env.local` keys to Vercel project settings (Production + Preview). (A deploy missing the Supabase boot keys serves a read-only `/setup` page with copy-paste guidance instead of crashing - there is no writable env file on Vercel, so the wizard can't write for you there.)
3. Update `LOCAL_CC_ENGINE_URL` on the runner host to the Vercel URL (e.g. `https://devpilot.vercel.app`).
4. Add the Inngest Vercel integration — it auto-registers `/api/inngest` and replaces the local Inngest dev server.
5. Re-run `infra/launchd/install.sh` so the runner picks up the new `LOCAL_CC_ENGINE_URL`.

Supabase, Upstash, Langfuse, and Anthropic all already point at managed/cloud endpoints — no extra deploy work for those.
