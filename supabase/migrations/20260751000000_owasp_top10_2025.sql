-- OWASP Top 10 checklist: 2021 -> 2025.
--
-- OWASP Top 10:2025 is the current release and supersedes 2021. The seeded
-- body cited 2021 in its header, its summary and every line. That list is not
-- a re-wording of the old one: SSRF was folded into A01, "Vulnerable and
-- Outdated Components" became A03 Software Supply Chain Failures, A10
-- Mishandling of Exceptional Conditions is new, and six categories moved rank.
-- Source and quotes are in the PR body.
--
-- This body is standing system-prompt text on every dispatch of eight roles,
-- so a stale-but-correctly-labelled list is survivable and a confidently wrong
-- one is not. The list below was taken from owasp.org/Top10/2025, not written
-- from memory.
--
-- ===========================================================================
-- THE DELIVERY DECISION, AND WHY IT NEEDED TWO STATEMENTS RATHER THAN ONE
-- ===========================================================================
--
-- `installSkillAction` COPIES the body into a tenant-owned row, and
-- `selectSkillsForDispatch` reads only tenant rows. So editing the public seed
-- reaches an operator who has already installed the skill NOT AT ALL. There
-- were two routes and both had a real cost:
--
--   • IN-PLACE over tenant clones. He gets the fix without doing anything --
--     but a body update is new prompt text he never reviewed being spliced
--     into his agents' system prompts. `20260744000000` justified in-place
--     precisely on the grounds that it "introduces no prompt text the operator
--     has not already consented to". That argument is NOT available here: this
--     change is nothing but new prompt text.
--
--   • VERSION BUMP, leaving his 1.0.0 alone. Nothing changes under him without
--     consent -- but historically that meant the fix reached nobody.
--
-- PR #150 (`lib/marketplace/skill-provenance.ts`) is what makes the second one
-- honest for the first time: an installed copy is compared against the
-- catalogue and an available upstream version is surfaced on the card, so the
-- operator can take it deliberately. THE BUMP IS THEREFORE THE ROUTE CHOSEN --
-- consent is preserved AND the fix is visible.
--
-- But that machinery does not deliver it on its own, and the second statement
-- below is why. `classifySkillProvenance` distinguishes "I edited it" from
-- "the catalogue moved" using a BASELINE recorded in the manifest, and
-- `installSkillAction` DOES NOT WRITE ONE -- only a save or a reset does, and
-- this clone has had neither. Verified against production: the clone's
-- manifest holds `author`/`summary`/`verified` and no `devpilot_edit` key.
--
-- With no baseline, moving the public body lands the clone on
-- `diverged_unknown` -- "DevPilot did not record which side changed ... it
-- predates edit tracking" -- which is both untrue here (we know exactly which
-- side changed) and unactionable: a vague amber warning instead of the
-- "Catalogue updated ... review the new text and take it if you want it"
-- notice plus the "Take the catalogue version" control. That is the version
-- bump nobody notices, wearing a warning badge.
--
-- So this migration RECORDS THE FACT THE INSTALL PATH FAILED TO RECORD, and
-- only where it can prove it. The clone's body is byte-identical to the public
-- 1.0.0 body, so `{edited_at: null, upstream_version: '1.0.0', upstream_body:
-- <the 2021 text>}` is a true statement of sync, which is exactly what a reset
-- would have written. After the seed moves, `upstreamMoved` is true and
-- `editedAt` is null, so the clone classifies `upstream_changed`.
--
-- THE BODY-EQUALITY GUARD IS THE SAFETY PROPERTY, not tidiness. Stamping
-- `edited_at: null` on a clone the operator HAD edited would assert his text is
-- the catalogue's, and the reset control would then offer to replace it under
-- copy reading "You have no recorded edits to lose". A clone that differs by so
-- much as one character is left alone and correctly reports `diverged_unknown`.
-- The `not ... ? 'devpilot_edit'` guard is the same refusal from the other side:
-- an existing record is the operator's own history and is never overwritten.
--
-- ORDER MATTERS: the baseline captures the 2021 text FROM the public row, so it
-- must be stamped BEFORE that row is updated. Reversing these two statements
-- would record the 2025 body as the baseline and silently defeat the whole
-- mechanism -- the clone would then read `pristine` while serving the 2021
-- list.
--
-- Live dry-run counts against production are in the PR body.
--
-- No agent-facing surface. Targets are unchanged from `20260744000000`; the
-- 2025 content does not change who should receive this.

-- ---------------------------------------------------------------------------
-- 1. Record the sync point on unedited clones-of-this-seed, from the 2021 text.
-- ---------------------------------------------------------------------------
--
-- Scoped to `installed_from_skill_id is not null` -- clones of a seed only,
-- which is strictly narrower than the required
-- `(tenant_id is null or installed_from_skill_id is not null)` and so cannot
-- touch hand-authored operator content. Joined through the clone's own source
-- pointer, so the row supplying the baseline is the row it was installed from.

update public.skills as c
set manifest = coalesce(c.manifest, '{}'::jsonb) || jsonb_build_object(
  'devpilot_edit', jsonb_build_object(
    'edited_at', null,
    'upstream_version', p.version,
    'upstream_body', p.body
  )
)
from public.skills as p
where p.id = c.installed_from_skill_id
  and c.installed_from_skill_id is not null
  and p.tenant_id is null
  and p.name = 'OWASP Top 10 checklist'
  and p.version = '1.0.0'
  -- Provably unedited: the only condition under which `edited_at: null` is true.
  and c.body = p.body
  -- Never overwrite a record the operator's own save or reset already wrote.
  and not (coalesce(c.manifest, '{}'::jsonb) ? 'devpilot_edit');

-- ---------------------------------------------------------------------------
-- 2. Move the public seed to the 2025 list, at 2.0.0.
-- ---------------------------------------------------------------------------
--
-- An UPDATE in place, NOT an insert of a second row. The row id is the key
-- every clone's `installed_from_skill_id` points at and the key the catalogue
-- resolves an installed card by, so preserving it is what keeps the operator's
-- copy attached to its source. Inserting a 2.0.0 row beside the 1.0.0 one
-- would instead leave the clone pointing at a stale seed (reporting `pristine`
-- forever, the fix reaching nobody) and put two same-named rows in the
-- catalogue -- and `selectSkillsForDispatch` has no notion of "latest", so any
-- workspace installing both would get the 2021 and 2025 lists merged into one
-- prompt, adjacent and contradicting.

update public.skills
set
  version = '2.0.0',
  manifest = coalesce(manifest, '{}'::jsonb) || jsonb_build_object(
    'summary', 'Quick OWASP Top 10 (2025) review pass for code changes.'
  ),
  body = $body$SKILL — OWASP Top 10 checklist (2025):
For each change, walk this list and call out any hit:
  A01 Broken access control — does any new endpoint skip its tenant/role check, or trust a record id from the request without an ownership check? Includes SSRF, folded into A01 for 2025: a URL fetched from user input with no allow-list.
  A02 Security misconfiguration — debug flags, permissive CORS, default credentials, a stack trace reaching the response body?
  A03 Software supply chain failures — a new or bumped dependency: pinned, lockfile updated, from an official source? Any edit to a build script or CI workflow, which this category now covers alongside the components themselves?
  A04 Cryptographic failures — secrets in code or logs, weak or hand-rolled hashing, sensitive data stored or transmitted in the clear?
  A05 Injection — string-concat SQL, shell, or template paths? Unescaped values rendered into HTML (XSS lives here)?
  A06 Insecure design — missing rate limits, no abuse model, a trust boundary the design never states?
  A07 Authentication failures — predictable tokens, no lockout, sessions that survive a credential change?
  A08 Software or data integrity failures — unsigned artifacts, unsafe deserialisation, an update path that never verifies what it applied?
  A09 Security logging and alerting failures — does the failure path actually log, and would the log reach a person?
  A10 Mishandling of exceptional conditions — new in 2025: on an error does this code fail closed? An unchecked return value, a caught exception leaving a transaction half-applied, a resource never released?
Report hits as `[Axx] <one-line finding>` lines; absence is fine to state as "no findings".
Two categories only partly survive contact with a diff, and saying so is better than padding: A03 is mostly an organisation-level control (SBOM, artifact registry and repository hardening) of which only the dependency and build-script edges are visible here; A06 is a property of a design, so a diff can show a missing control but never confirm the design is sound. State that limit rather than inventing a finding to fill the slot.$body$
where tenant_id is null
  and name = 'OWASP Top 10 checklist'
  and version = '1.0.0';
