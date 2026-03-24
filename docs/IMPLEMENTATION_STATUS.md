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

