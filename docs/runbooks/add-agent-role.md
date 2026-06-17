# Runbook: Add a new agent role

**When to use:** You need a new built-in role in the catalog (a new specialist the
classifier can route to and the RoleSelect combobox can offer), e.g. `perf_engineer`.

Roles are just data: a system prompt + model tier + runner policy + the ticket status the
role lands on success. The registry enforces that every role is also in the catalog and the
eval set, so the change touches four places plus a snapshot.

## Prerequisites

- Local dev set up (see README.md → Quick start). No DB or services needed for the code change.
- Pick a stable `slug` (snake_case, used everywhere) and a `displayName`.

## Steps

1. **Create the role file** `apps/web/lib/roles/<slug>.ts`, exporting a `RoleConfig`.
   Copy the shape from an existing small one such as `apps/web/lib/roles/pm.ts`:
   `role`, `displayName`, `modelTier`, `runnerPolicy` (`"local-cc"` for the default runner),
   `onSuccessStatus`, and `systemPrompt`. Keep the prompt in the documented output shape the
   role's evals will assert against.
   Note that `onSuccessStatus` does double duty: setting it to `"in_review"` also opts the role
   into the **reviewer-awareness note**, appended to its prompt at dispatch time (see Gotchas).
2. **Add the slug to the `Role` union** in `apps/web/lib/roles/types.ts`.
3. **Register the role** in `apps/web/lib/roles/index.ts`: import your `<slug>Role` and add it
   to the `ROLES` record.
4. **Add a catalog entry** in `apps/web/lib/roles/catalog.ts` (`ROLE_CATALOG`): `slug`,
   `displayName`, `category`, and a one-line `purpose`. These fields are user-visible copy:
   the classifier prompt uses `purpose`, and the `/agents` role-card gallery renders `purpose`
   verbatim as the card description, `category` as the section it groups under (section order
   follows first declaration in `ROLE_CATALOG`), and `displayName` as the marketplace role chip -
   so write them to read cleanly. The card's model-tier badge comes from `modelTier` in step 1.
   **Invariant:** every key in `ROLES` must have a catalog entry - a runtime check at the bottom
   of `catalog.ts` logs a `console.error` warning on import (in dev) listing any `ROLES` slug
   missing a catalog entry, so a miss surfaces as a loud console warning rather than a hard crash.
5. **Add the eval + snapshot** under `tests/evals/`: a `<slug>.eval.yaml` (copy an existing one,
   e.g. `qa.eval.yaml`) and regenerate the frozen prompt snapshot:
   `node --import tsx tests/evals/snapshot-prompts.mjs`. Add the role to
   `tests/evals/promptfooconfig.yaml` if you want it in the documented set.
   See `tests/evals/README.md` for how a role is evaluated.

## Verify

- `pnpm --filter @devpilot/web typecheck` passes (catches a missing `Role` union entry).
- `node --import tsx tests/evals/snapshot-prompts.mjs --check` passes (snapshot is current).
- Dev-run the app (`pnpm --filter web dev`) and confirm the role appears in the RoleSelect
  combobox on a new ticket and as a card (correct `category` section, `purpose`, and model-tier
  badge) in the `/agents` gallery once its agent row materializes; optionally run its eval per
  `tests/evals/README.md`.

## Gotchas

- The catalog runtime check only fires when the module loads in dev - a `typecheck`-only pass
  will not catch a missing catalog entry, so actually run the app or a script that imports `catalog.ts`.
- The YAML eval and its `snapshots/<slug>.system.txt` must change together; editing a prompt
  without regenerating the snapshot makes CI's `--check` fail.
- `runnerPolicy` should be `"local-cc"` unless the role genuinely needs the API runner - see
  README.md → design rules (runner-first) and the concurrency note.
- Don't hand-write "your work will be reviewed by QA" into `systemPrompt`.
  Every role with `onSuccessStatus: "in_review"` already gets the fenced reviewer-awareness note
  appended on every ticket-bound dispatch by `composeRoleSystemPrompt`
  (`apps/web/lib/roles/compose-prompt.ts`); writing your own version just says it twice.
  Roles that self-drive to `done` (qa/verifier/release_engineer) or land elsewhere
  (pm → `ready`, triage → `in_progress`) never get the note.
  See README.md → Architecture quick reference → Reviewer-awareness.
- The note is merged fresh at dispatch and never persisted into the stored prompt, so it does
  **not** belong in `snapshots/<slug>.system.txt` - the snapshot is the bare role prompt.
