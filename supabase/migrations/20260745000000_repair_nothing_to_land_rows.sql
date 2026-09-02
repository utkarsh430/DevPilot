-- Repair integration_queue rows that recorded a "nothing to land" outcome as a
-- land FAILURE.
--
-- ─── what happened ────────────────────────────────────────────────────────
--
-- A verification ticket (QA, verifier) legitimately finishes having changed no
-- files, so its branch sits at the exact commit already on the integration
-- branch. GitHub refuses to open a pull request between two identical refs with
-- `422 Validation Failed`, and the land worker recorded that verbatim:
--
--   status     = 'failed'
--   attempts   = 3
--   pr_number  = NULL
--   last_error = 'GitHub 422 on /repos/<owner>/<repo>/pulls: Validation Failed'
--
-- The OUTCOME was right — there was genuinely nothing to ship. The REPORTING was
-- not: the board rendered a red "Not landed — land failed" card on a ticket that
-- was entirely healthy, and the recorded message gave the operator no way to
-- tell "nothing to ship" from "your shipping is broken".
--
-- The code fix (PR: `classifyPullRequestFailure`) means no NEW row can end this
-- way. This migration settles the rows already recorded before it.
--
-- ─── the repaired state, and why it is `cancelled` rather than `landed` ────
--
-- The live path for this outcome stamps `landed` with the base tip, because
-- `builds_on` dependents gate on LANDED and a review-only ticket that stamped
-- nothing would wedge them forever. SQL cannot resolve that sha — it lives on
-- GitHub — and inventing one is out of the question: `landed_sha` is the single
-- fact the whole dependency graph trusts.
--
-- So this migration takes the CONSERVATIVE half. `cancelled` is the existing
-- terminal non-failure status the land policy already writes for the sibling
-- case ("ticket has no branch with work to land"), and `deriveLandingState`
-- already reads it as `nothing_to_land` with a neutral `info` treatment. The
-- repair therefore changes only the REPORTING: it stamps no sha, releases no
-- dependent, and claims no landing. If the inference were somehow wrong about a
-- given row, nothing downstream has been unblocked on false evidence — the
-- worst case is a ticket that reads "nothing to land" and can be re-landed by
-- hand from the ticket drawer, which is strictly better than the red card it
-- shows today.
--
-- `cancelled` is also outside every reaper's scope: `integrationQueueReaper`
-- scans `landing` / `awaiting_merge_resolution`, `landRescueReaper` scans
-- `pending`. A repaired row is settled and stays settled.
--
-- ─── the scope, which is the part to get right ────────────────────────────
--
-- This is deliberately NOT a rewrite of failed rows. Four predicates, all
-- required, all conjunctive:
--
--   1. status = 'failed'          — only a recorded failure is being reinterpreted.
--   2. last_error matches the PR-creation 422 signature EXACTLY. GitHub emits
--      this string shape from one place only: `throwFromResponse` on a
--      `POST /repos/…/pulls` that returned 422 with the generic top-level
--      message. Any other land failure — a push rejection, a conflict, a merge
--      refusal, a token problem, a 5xx — writes different text and is untouched.
--   3. pr_number IS NULL          — no pull request was ever created. The 422
--      shapes that are NOT "no commits between" (most notably "a pull request
--      already exists") describe a world where a PR does exist, so requiring its
--      absence here is what keeps a genuinely stranded ticket out of scope.
--   4. merge_sha IS NULL          — nothing was ever merged for this row.
--
-- The `select` below reports exactly which rows moved, so the count can be
-- compared against expectation when this is applied.

do $$
declare
  moved integer;
begin
  with repaired as (
    update public.integration_queue q
       set status     = 'cancelled',
           last_error =
             'nothing to land: the branch carried no commits the integration branch '
             'lacked, so GitHub refused the pull request (422). Recorded as a failure '
             'before DevPilot detected this case locally; repaired by migration '
             '20260745000000. No pull request was opened and nothing was merged.',
           updated_at = now()
     where q.status     = 'failed'
       and q.pr_number  is null
       and q.merge_sha  is null
       -- The exact shape `throwFromResponse` writes for a PR-creation 422 whose
       -- reason GitHub buried in `errors[]`. `%` spans only the owner/repo.
       and q.last_error like 'GitHub 422 on /repos/%/pulls: Validation Failed'
    returning q.id
  )
  select count(*) into moved from repaired;

  raise notice 'repair_nothing_to_land_rows: settled % integration_queue row(s)', moved;
end
$$;
