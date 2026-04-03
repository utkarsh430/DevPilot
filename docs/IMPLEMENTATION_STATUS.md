# DevPilot — Implementation Status (Planned vs Built)

**Purpose:** a living, truthful map of what DevPilot _planned_ against what is _actually built_, and — most importantly — a single list of what is **not yet implemented**.
This is the gap document that the planning docs (PRD, TDD, phase plans) do not provide.

**Audited state:** `feat-BE-migration_to-Go` @ `2fb8235` ("feat(runner): cancel wedged local-cc claude runs on timeout + fail-closed budget breaker").
**Date:** 2026-07-05.
**Provenance:** produced from a full four-slice audit of the branch (docs/phase spine, web app, runner + Go-migration, platform/data/infra), each with `file:line` evidence.
Every specific line-number claim below was re-verified against the live tree, which is authoritative.

> **How to read this doc.** The "Current state" and "What's built" sections tell you the codebase is far more complete than the older status docs imply.
> The "Not yet implemented" section is the real gap list — start there if you are deciding what to build next.

---

## Current state (truthful)

Phase 0, Phase 1, and **most** of the Phase-2 plan have shipped, plus a large emergent **"Phase 2.5 / 2.5++"** surface that no planning doc formally defines.
The prior status docs badly understate this: `README.md` and `CLAUDE.md` (before this cleanup) still called the project "Phase 0 (MVP in progress)," and `SESSION_HANDOFF.md` freezes at 2026-06-11 while the branch shipped through 2026-07-05.

Concretely:

- **Phase 0** (durable engine + board + PM/Eng/QA + local CC runner + tracing): shipped. Two of the five named P0 _screens_ were never built — see the gap list.
- **Phase 1** (M0–M16: more roles, custom roles, parallel/branching, supervisor trees, SQL/text-to-SQL, marketplaces, evals + replay, agents-as-APIs + widget, billing, Agent Builder): shipped.
- **Phase 2 production plan** (M0–M4): only **M0** (stale-run reaper) and the emergent **M5 series** shipped. **M1, M2, M4 are not built**; M3 is partial. See the gap list.
- **Phase 2.5 / 2.5++** (undocumented): a large body of shipped work — take-the-wheel cockpit, platform secrets manager + app-layer AES, live tmux terminal attach, per-project repos + GitHub OAuth, plan-mode multi-agent chat, dev-servers, notifications, team tiers, stacked tickets, merger role, fail-closed budget breaker — exists only in git history and partial handoff rows.

The schema has grown from the ~12 core tables the TDD models to **~35 tables** across **54 forward-only migrations** (as of 2026-07-07), most for Phase 2/2.5 features the phase plans never enumerate.

---

