# Runbooks

A runbook is a short, ordered recipe for a **recurring, non-trivial task** in this repo.
The goal is simple: the second time anyone (human or agent) does a task, they should not
have to re-derive it from the code or repeat a past mistake.

## The contract

- **Before** starting a task, check for a matching runbook here and follow it.
- **After** completing a repeatable task (or fixing a runbook that was wrong), capture or
  update its runbook. This is part of "done", not optional cleanup.
- Keep each runbook **tight**: prerequisites, the ordered steps with exact files/commands,
  then verification and gotchas. If it grows past ~1 screen, link out to the relevant
  `docs/` design doc instead of inlining the theory.
- One task per file. Name files `kebab-case.md` matching the task
  (e.g. `add-agent-role.md`).

A runbook records _how we do it here_ - the concrete files, commands, and invariants.
It is not a design doc; the "why" lives in `docs/DEVPILOT_PRD.md` / `docs/DEVPILOT_TDD.md`. Link, don't copy.

## Template

Copy `_TEMPLATE.md` to a new file and fill it in.

## Index

| Runbook                                                                    | When to use it                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`add-agent-role.md`](add-agent-role.md)                                   | Add a new agent role to the catalog (e.g. a new specialist).                      |
| [`add-database-migration.md`](add-database-migration.md)                   | Add a forward-only Supabase SQL migration.                                        |
| [`add-inngest-function.md`](add-inngest-function.md)                       | Add a new durable Inngest function to the engine.                                 |
| [`reconfigure-instance-credential.md`](reconfigure-instance-credential.md) | Add / rotate / repair any platform credential (Redis, LLM keys, GitHub OAuth, …). |

When you add a runbook, add a row here.
