// Canonical `targets` for the twelve first-party marketplace skills.
//
// WHY THIS FILE EXISTS. `targets` was seeded once, in
// `20260603090000_m11_marketplace.sql`, against the eight roles that existed
// at the time (engineer, pm, qa, devops, techwriter, designer, dataeng,
// security). Phase 2 added ~43 more roles. Selection matches EXACTLY
// (`targets.includes(role)` — `lib/skills/select.ts`), so every later role
// silently resolved to zero skills: the role that actually writes the markup
// could not receive the accessibility skill, and the one role whose prompt
// names OWASP as its hunting ground could not receive the OWASP skill.
//
// Nothing failed. That is the whole problem — exact-slug matching drifts
// silently, and it will drift again the next time a role is added. This
// module is the durable home for the mapping so `__tests__/first-party-targets.test.ts`
// can assert (a) no skill targets a slug that does not exist, and (b) the
// roles this realignment set out to cover actually resolve to something.
//
// THE RULE APPLIED WHEN WIDENING. A skill body is standing system-prompt text
// (`lib/skills/merge.ts`) that fires on EVERY dispatch of a targeted role.
// Adding a role is therefore not free and not neutral: wrong guidance in a
// prompt is worse than absent guidance, because the role will follow it. So a
// role was added only when the body, read as written, genuinely helps it —
// never on a name match. Where a role plausibly deserves coverage but the
// existing body would mislead it, it is listed in DELIBERATELY_UNCOVERED with
// the reason, rather than widened anyway.
//
// This module changes no mechanism. Matching is still exact-slug; see the PR
// body for the recommended follow-up (role families / capability tags).

import { ROLES } from "@/lib/roles";

/** Name → role slugs. Keyed on `skills.name`, which is stable across versions. */
export const FIRST_PARTY_SKILL_TARGETS: Record<string, readonly string[]> = {
  // Structure for a design proposal: 6 headings, alternatives, rollout.
  //
  // ADDED: the four dual-mode engineering specialists. Each has a PROPOSAL
  // mode that emits a free-form plan with no prescribed shape, which is
  // exactly the gap an RFC skeleton fills — the same reason `engineer` was
  // targeted originally.
  //
  // NOT ADDED — and this is the interesting exclusion. `software_architect`,
  // `cto`, `staff_engineer` and `tech_lead` are the roles a name match would
  // grab first, and all four are wrong: each already mandates its OWN
  // competing output structure (an ADR file under `docs/adr/`; a CTO-format
  // RFC with a trade-offs table and migration path; an inline 8-15 line
  // `// ADR:` block; a fixed 4-section review). Merging a second, different
  // heading set into those prompts creates a conflict the model has to
  // resolve at dispatch time. Absent beats contradictory.
  "RFC writer": [
    "engineer",
    "techwriter",
    "pm",
    "frontend_engineer",
    "backend_engineer",
    "fullstack_engineer",
    "mobile_engineer",
  ],

  // A01-A10 walk, reported as `[Axx] finding`.
  //
  // ADDED: `appsec_engineer` — the headline miss. Its prompt says outright
  // "Your hunting ground is the OWASP Top 10", so the skill was targeting
  // every role except the one built for it. `security_engineer` fixes and
  // hardens (STRIDE-first, but the A-list complements rather than competes:
  // one is a threat-modelling frame, the other a review checklist).
  // `backend_engineer` / `fullstack_engineer` write the endpoints and RLS
  // policies A01/A05 are about. `frontend_engineer` owns the A05 (XSS),
  // A02 (CORS) and A07 surface. `cloud_engineer` owns IAM scoping, secrets
  // rotation and allowlists — A01/A02/A04 directly.
  //
  // The category numbers above are the 2025 ones, re-derived when
  // `20260751000000` moved the body to OWASP Top 10:2025. They are NOT a
  // re-labelling: six categories changed rank, XSS moved from A03 to A05,
  // CORS misconfiguration from A05 to A02, and SSRF stopped being A10 and
  // folded into A01. The eight roles are unchanged — the 2025 content does
  // not change who should receive this list, only what it says.
  //
  // NOT ADDED: `compliance_grc` writes policy text, not code review; a
  // per-change code checklist is the wrong instrument for it.
  "OWASP Top 10 checklist": [
    "security",
    "engineer",
    "appsec_engineer",
    "security_engineer",
    "backend_engineer",
    "fullstack_engineer",
    "frontend_engineer",
    "cloud_engineer",
  ],

  // EXPLAIN (ANALYZE, BUFFERS) first, then one index per finding.
  //
  // ADDED: `dba` owns index strategy and its prompt already requires
  // EXPLAIN before/after — the skill reinforces its own discipline rather
  // than competing with it. `backend_engineer` / `fullstack_engineer` write
  // migrations. `analytics_engineer` owns warehouse transformations and mart
  // views.
  //
  // NOT ADDED: `data_analyst` and `data_scientist` hold READ-ONLY query
  // tools. Instructing a role to propose indexes it has no path to create
  // produces recommendations nobody can act on.
  "PostgreSQL index advisor": [
    "dataeng",
    "engineer",
    "dba",
    "backend_engineer",
    "fullstack_engineer",
    "analytics_engineer",
  ],

  // Six numbered WCAG checkpoints with a smallest-fix per failure.
  //
  // ADDED: `frontend_engineer` is the audit's headline example — the role
  // that writes the markup could not receive the accessibility skill. Plus
  // the other two roles that ship UI (`fullstack_engineer`, `mobile_engineer`)
  // and the three design specialists that superseded the legacy `designer`.
  // `ui_designer`'s prompt already mandates that every state clears WCAG AA;
  // the skill supplies the checkpoint NUMBERS that claim needs to be auditable.
  //
  // NOT ADDED: `ux_researcher` plans and synthesises research; it produces no
  // interface to audit.
  "WCAG 2.1 AA quick audit": [
    "designer",
    "engineer",
    "frontend_engineer",
    "fullstack_engineer",
    "mobile_engineer",
    "ui_designer",
    "ux_designer",
    "product_designer",
  ],

  // UNCHANGED — deliberately. See DELIBERATELY_UNCOVERED.
  "K8s rollback runbook": ["devops"],

  // UNCHANGED — deliberately. See DELIBERATELY_UNCOVERED.
  "Conventional commits": ["engineer"],

  // Classify each new test unit/integration/e2e, flag skew.
  //
  // ADDED: the two roles that own tests as their product — `qa_automation_engineer`
  // (writes the tests) and `sdet` (builds the infrastructure they stand on) —
  // plus the three producers who add tests alongside code.
  //
  // NOT ADDED: `ml_engineer`'s tests are Promptfoo gold sets; the
  // unit/integration/e2e taxonomy does not map onto an eval suite, so the
  // ratio thresholds would fire meaninglessly. `security_engineer` /
  // `appsec_engineer` ship exactly one regression test per fix — a
  // pyramid-BALANCE instrument has nothing to say about a single test, but
  // its ">50% E2E" rule would flag them every time.
  "Test pyramid reviewer": [
    "qa",
    "engineer",
    "qa_automation_engineer",
    "sdet",
    "backend_engineer",
    "frontend_engineer",
    "fullstack_engineer",
  ],

  // Per-route doc section, derived from the handler source.
  //
  // ADDED: `backend_engineer` writes the route handlers, `fullstack_engineer`
  // writes both surfaces, `staff_engineer` explicitly owns the public `/v1`
  // contracts.
  //
  // NOT ADDED: `technical_product_manager` writes API DESIGN docs for APIs
  // that do not exist yet. The body's load-bearing line is "Derive every
  // field from the actual handler source — do not invent fields", which is
  // unfollowable when there is no handler, and would push it toward
  // documenting a design as though it were shipped.
  "API docs from handler": [
    "techwriter",
    "engineer",
    "backend_engineer",
    "fullstack_engineer",
    "staff_engineer",
  ],

  // Description + 3-6 testable ACs + out-of-scope; escalate rather than invent.
  //
  // ADDED: `product_owner` already writes Given/When/Then ACs with an
  // out-of-scope list — the same artifact. `business_analyst` writes
  // requirements docs with testable ACs.
  //
  // NOT ADDED: `product_manager`'s prompt says outright it does NOT write
  // acceptance criteria for an individual ticket and should push that back to
  // `pm`. Widening here would instruct it to do the thing its own prompt
  // forbids. `triage` must NOT call `devpilot_move_ticket`, and this body
  // instructs a move to `input_required` — a direct contradiction of its
  // role contract.
  "PM ticket refiner": ["pm", "product_owner", "business_analyst"],

  // UNCHANGED — deliberately. See DELIBERATELY_UNCOVERED.
  "SQL safety checks": ["dataeng"],

  // Per-criterion observable → PASS/FAIL; "no test, no pass".
  //
  // ADDED: `verifier` is the final gate after QA and benefits from the same
  // criterion→observable discipline. `product_owner` already renders per-AC
  // PASS/FAIL story-acceptance verdicts — this is its exact artifact.
  // `qa_automation_engineer` picks the lowest test layer that covers each AC,
  // which is the same mapping viewed from the authoring side.
  //
  // NOT ADDED: `tech_lead` renders APPROVE/REQUEST_CHANGES/BLOCK inside a
  // fixed 4-section review; a competing per-criterion verdict format would
  // fight it.
  "QA acceptance verifier": ["qa", "verifier", "product_owner", "qa_automation_engineer"],

  // Empty / loading / error / first-success per screen.
  //
  // ADDED: the three design specialists that superseded the legacy
  // `designer`, and the three roles that actually build the screens.
  //
  // NOT ADDED: `ux_researcher` produces no screens.
  "Designer empty-state checklist": [
    "designer",
    "engineer",
    "ui_designer",
    "ux_designer",
    "product_designer",
    "frontend_engineer",
    "fullstack_engineer",
    "mobile_engineer",
  ],
};

/**
 * Name → role slugs for the 40 skills seeded by
 * `20260746000000_first_party_skills_batch2.sql`.
 *
 * WHY A SECOND RECORD RATHER THAN MORE KEYS IN THE FIRST. The record above is
 * documented as, and asserted to be, exactly the twelve rows M11 seeded — the
 * test cross-checks it against BOTH the M11 seed migration and the
 * 20260744000000 realignment. Folding a new batch into it would break that
 * correspondence and, worse, blur which migration owns which row. The two are
 * combined at the point where the combination is what matters (selection), by
 * `allFirstPartySkillTargets()`.
 *
 * THE SAME DRIFT GUARD APPLIES. `keywordFilter` (`lib/skills/select.ts`) is an
 * exact slug match with no error path, so a target naming a role that does not
 * exist resolves to nothing, forever, silently. That is the defect
 * 20260744000000 repaired for the first twelve; listing this batch here is
 * what puts it inside the same test.
 *
 * TARGETS ARE COPIED AT INSTALL TIME. `installSkillAction` clones `targets`
 * into the tenant's row and `loadInstalledSkills` reads from THAT row, so
 * widening one of these later is a migration over tenant clones — scoped to
 * `(tenant_id is null or installed_from_skill_id is not null)`, or it silently
 * retargets an operator's own same-named skill.
 */
export const BATCH2_SKILL_TARGETS: Record<string, readonly string[]> = {
  // --- Core engineering ---------------------------------------------------
  //
  // Deliberately SMALL. `engineer`, `fullstack_engineer`, `backend_engineer`
  // and `frontend_engineer` already carry 5-8 of the original twelve each,
  // and `selectSkillsForDispatch` truncates to 8 candidates BEFORE ranking
  // and then fires 3. Adding freely to a saturated role does not add coverage,
  // it displaces it — so this batch spends its engineering budget on sharp,
  // narrowly-triggered skills and leaves the broad "how to work" advice to the
  // role prompts, where it belongs. See the PR body's cut list.
  "Use-server export rule": [
    "engineer",
    "backend_engineer",
    "fullstack_engineer",
    "frontend_engineer",
    "staff_engineer",
  ],
  "Build-time env is a cache key": ["frontend_engineer", "fullstack_engineer", "backend_engineer"],
  // NOT targeted at `backend_engineer` despite the draft proposing it: this is
  // aimed at the reviewing/designing half of the family, and those three roles
  // carry 0-1 skills each while backend_engineer is already at the cap.
  "A control that exists is not a control that runs": [
    "tech_lead",
    "staff_engineer",
    "software_architect",
  ],

  // --- Infrastructure and data --------------------------------------------
  //
  // `sre` is NOT targeted by the deploy skill: its own prompt says outright
  // "You are NOT the deploy/config role — that's devops". `release_engineer`
  // is excluded from both the deploy and the CI-push skills because it is
  // under a hard prohibition on pushing at all.
  "Deploy smoke check": ["devops", "cloud_engineer", "platform_engineer"],
  "Constraint audit before a schema change": ["dba", "dataeng", "analytics_engineer"],
  // Single-role on purpose: `platform_engineer` is the only role whose prompt
  // names turbo config as a home. Widening would put build-tool guidance into
  // deploy and database prompts that will never act on it.
  "Build cache and environment": ["platform_engineer"],
  "Schema is not shipped by a deploy": ["dba", "dataeng", "analytics_engineer", "devops"],
  "Row caps and counting": ["data_analyst", "data_scientist", "dataeng", "analytics_engineer"],
  // `triage` is deliberately absent: its entire output is a size
  // classification, so investigation-ORDER advice has nothing to attach to,
  // and it is the cheapest role in the chain.
  "Evidence before hypothesis": [
    "sre",
    "devops",
    "platform_engineer",
    "technical_support_engineer",
  ],
  // Absorbs two engineering drafts (PostgREST embed ambiguity on a new FK, and
  // the column-list/stored-function pair) — hence the two engineering roles
  // alongside the data ones. They are the roles that actually write
  // `alter table … references` here.
  "What a migration touches outside its own file": [
    "dba",
    "dataeng",
    "analytics_engineer",
    "backend_engineer",
    "fullstack_engineer",
  ],
  "Polling against a metered service": ["sre", "platform_engineer", "devops"],
  "Prove the rebase preserved the work": ["release_engineer"],
  "What a green eval run proves": ["ml_engineer"],
  "A rotation is not finished at the vault": ["cloud_engineer", "it_admin"],
  "Pushes that touch CI definitions": ["platform_engineer", "devops"],

  // --- Quality and security -----------------------------------------------
  //
  // The widest list in the batch, and the one that earns it: it is the merge
  // of two crews' drafts of the same idea (test-fake vacuity + mutation
  // verification), so its targets are the union of a producer set and a
  // test-author set. Every one of them writes tests.
  "Green until proven red": [
    "sdet",
    "qa_automation_engineer",
    "qa",
    "appsec_engineer",
    "security_engineer",
    "engineer",
    "backend_engineer",
    "fullstack_engineer",
    "staff_engineer",
  ],
  "Where tests actually run": ["qa_automation_engineer", "sdet"],
  // Also a merge: the test-author's "where is the seam" and the producer's
  // "structure the guard so a test can reach it" are one instruction with two
  // readers.
  "What can be tested here": [
    "sdet",
    "qa_automation_engineer",
    "engineer",
    "backend_engineer",
    "fullstack_engineer",
    "staff_engineer",
    "software_architect",
  ],
  "Verify the artifact you tested": ["verifier", "qa"],
  "Did the work actually land": ["qa", "verifier"],
  // Single-role: `verifier` exists precisely for "passes tests but does not
  // boot", and its prescribed boot check is provably blind to this class.
  "Authed-route boot check": ["verifier"],
  "Agent trust boundary review": ["appsec_engineer", "security_engineer", "security"],
  // `sdet` is deliberately absent — its own prompt already carries this rule
  // ("NEVER reuse a production database in tests"). The roles targeted are the
  // ones that ship migrations and SQL assertions and were never told.
  "Which database are you touching": [
    "security_engineer",
    "appsec_engineer",
    "backend_engineer",
    "fullstack_engineer",
    "engineer",
    "dba",
    "dataeng",
  ],
  "Compliance claims need a citation": ["compliance_grc"],

  // --- Product, design and research ---------------------------------------
  //
  // The broadest reach in the batch, and the only one that addresses a failure
  // which loses the ENTIRE artifact rather than degrading it: for these roles
  // the comment IS the deliverable and a dependent ticket's agent never sees a
  // comment.
  "Handoff to dependents": [
    "pm",
    "product_manager",
    "technical_product_manager",
    "product_owner",
    "business_analyst",
    "designer",
    "ui_designer",
    "ux_designer",
    "product_designer",
    "ux_researcher",
  ],
  // `product_manager` excluded: its prompt pushes individual-ticket ACs back
  // to `pm`, so this would be guidance for work it is told not to do.
  "Acceptance criteria a verifier can check": [
    "pm",
    "product_owner",
    "business_analyst",
    "technical_product_manager",
  ],
  // `ux_researcher` excluded here and covered by "Research from evidence that
  // exists" instead — the two share the "PostHog is not wired" fact, and no
  // role should receive it twice in one prompt.
  "Metrics only from live telemetry": [
    "product_manager",
    "product_designer",
    "technical_product_manager",
    "product_owner",
  ],
  "Spec against the installed design system": [
    "designer",
    "ui_designer",
    "ux_designer",
    "product_designer",
  ],
  // `ux_designer` excluded: its prompt scopes it to flows and information
  // architecture, and it is not asked for contrast ratios.
  "Contrast from resolved tokens": ["ui_designer", "product_designer", "designer"],
  "Research from evidence that exists": ["ux_researcher"],
  "Delivery signals, not sprint metrics": ["scrum_master", "project_program_manager"],

  // --- Leadership, docs and go-to-market ----------------------------------
  "Docs land in the repo": ["techwriter"],
  "Runbook conventions": ["techwriter"],
  "Shipped vs planned": [
    "sales_account_executive",
    "solutions_engineer",
    "marketing_manager",
    "customer_success_manager",
    "cto",
  ],
  "Board state is not the whole truth": ["technical_support_engineer"],
  "Follow-up work must be filed": ["cto", "vp_engineering", "engineering_manager"],
  // NOT given to `sales_account_executive`: its prompt already routes hard
  // technical questions to a human, and handing a seller a three-layer
  // security answer to deliver unsupervised is not an improvement.
  "Isolation claims need the real mechanism": ["solutions_engineer"],
  "Health metrics have engine noise": ["customer_success_manager"],
  "Cost claims about DevPilot": [
    "sales_account_executive",
    "solutions_engineer",
    "cto",
    "customer_success_manager",
  ],
  "Identifiers and the staged rename": ["techwriter", "marketing_manager", "solutions_engineer"],
};

/**
 * Roles left with zero skill coverage ON PURPOSE, with the reason.
 *
 * These are not oversights and they are not "not got to yet". Each is a role
 * where the honest answer is that no body helps it, and the fix is a skill
 * that does not exist yet rather than a target list that pretends otherwise.
 * Asserted by the test IN BOTH DIRECTIONS — an entry naming a role that now
 * resolves to a skill is a stale entry and fails — so a future reader cannot
 * mistake a deliberate gap for the same silent drift 20260744000000 repaired.
 *
 * `sre`, `release_engineer` and `platform_engineer` were listed here by
 * 20260744000000, each with the note "the skill that would fit it does not
 * exist yet". Those skills now exist (incident triage, rebase preservation,
 * build-cache and CI-push), so all three entries are gone.
 *
 * The three that remain are the roles the drafting crews looked at and
 * declined, not roles nobody reached.
 */
export const DELIBERATELY_UNCOVERED: Record<string, string> = {
  triage:
    "Its prompt is already a complete seven-clause risk heuristic, and its entire output is a size classification plus rationale — it produces no artifact to check and runs no commands, so every failure mode in the evidence base (stale artifacts, unlanded work, vacuous tests, wrong database) attaches to work it does not do. It is also the cheapest hop in the chain, so standing prompt text costs it proportionally most. Revisit once `agent_mistakes` holds triage rows and a CALIBRATION skill can be written from real classifications.",
  project_scaffolder:
    "Its prompt is 259 lines and already carries a five-clause 'what complete means' contract (committed lockfile, no placeholders in committed files, README may not promise machinery it did not ship, Dockerfile must build from committed sources, entry point must exist), each annotated with a defect the role has actually shipped, then re-checked against the diff in a later step. Every candidate skill was a strictly weaker subset of something already there.",
  implementation_specialist:
    "Despite its placement among the engineering roles it is a customer-onboarding role: its deliverables are runbooks, welcome sequences, integration checklists and Day-N checkpoints. The engineering skills would be actively wrong for it — a migration skill instructs work it never does — and there is no onboarding-failure evidence to write a real one from. Wrong guidance is worse than absent guidance.",
};

/**
 * Skills whose targets were deliberately NOT widened, with the reason.
 *
 * Widening a body that is wrong spreads the wrongness across every dispatch of
 * every added role. These three earn a stated refusal instead.
 */
export const DELIBERATELY_NOT_WIDENED: Record<string, string> = {
  "K8s rollback runbook":
    "The body instructs `kubectl` against a stack that has no Kubernetes, and `devops.ts` closes with 'Do NOT invent infra that isn't in this stack' — so the skill already contradicts the prompt it merges into. Widening it would multiply that contradiction across sre / cloud_engineer / platform_engineer / release_engineer. The audit's recommendation is cut-and-replace, which is a body change and out of scope here.",
  "SQL safety checks":
    "The body's opening line names the PRE-RENAME query-db tool (renamed to `devpilot_query_db` in the batch-2b rename), so it instructs the agent to gate a tool that no longer exists under that name. `data_analyst` and `data_scientist` hold `devpilot_query_db_smart` and are the roles a name match would add; adding them would put a dead tool name into two more prompts. All three of its rules are also enforced server-side already (dataeng.ts: SELECT-only, allow-listed tables, mandatory LIMIT).",
  "Conventional commits":
    "The rule is already stated in the system prompts of the very roles a widening would add — frontend_engineer, sre, security_engineer and appsec_engineer each spell out the commit format with their own examples. Widening would re-state it as standing prompt text on every dispatch of ~14 more roles for a convention no run has failed on. The audit recommends cutting the skill outright.",
};

/**
 * The roles this realignment set out to cover — the ones named in the audit as
 * resolving to zero skills. The test asserts each either resolves to at least
 * one skill or carries an explicit reason in DELIBERATELY_UNCOVERED.
 */
export const REALIGNMENT_TARGET_ROLES: readonly string[] = [
  "frontend_engineer",
  "backend_engineer",
  "fullstack_engineer",
  "mobile_engineer",
  "staff_engineer",
  "ui_designer",
  "ux_designer",
  "product_designer",
  "security_engineer",
  "appsec_engineer",
  "sre",
  "release_engineer",
  "dba",
  "platform_engineer",
  "cloud_engineer",
];

/**
 * Every first-party skill, both batches, as one name → targets map.
 *
 * A duplicate name across the two batches would silently take one entry's
 * targets and drop the other's — and, at runtime, would put two same-named
 * rows in front of `selectSkillsForDispatch`, which has no notion of "latest"
 * and would merge BOTH bodies into one prompt. The test asserts the key sets
 * are disjoint rather than trusting this spread.
 */
export function allFirstPartySkillTargets(): Record<string, readonly string[]> {
  return { ...FIRST_PARTY_SKILL_TARGETS, ...BATCH2_SKILL_TARGETS };
}

/**
 * Skill names that resolve for `role`, using the SAME predicate as
 * `keywordFilter` in `lib/skills/select.ts`: exact slug membership, with an
 * empty `targets` meaning "any role".
 *
 * This is a re-statement of that predicate, so the test suite also
 * source-scans `select.ts` to prove the two cannot silently diverge.
 */
export function firstPartySkillsForRole(role: string): string[] {
  return Object.entries(allFirstPartySkillTargets())
    .filter(([, targets]) => targets.length === 0 || targets.includes(role))
    .map(([name]) => name);
}

/** Every role slug that exists today. */
export function knownRoleSlugs(): Set<string> {
  return new Set(Object.keys(ROLES));
}
