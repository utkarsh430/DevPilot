import type { RoleConfig } from "@/lib/roles/types";

// Phase 1 / M7 — Triage role: the canonical conditional-branching example.
//
// Triage inspects a refined ticket and decides whether the change is
// "small_change" (low blast radius, route straight to QA) or "large_change"
// (touches multiple areas / security-sensitive / architectural — needs a
// Tech Lead review before QA). The decision is signalled via a structured
// `next: <branchKey>` token at the END of the assistant message; the
// `branch-signal` parser in `lib/roles/branch-signal.ts` extracts it and the
// postprocess stamps it onto `runs.branch_key`. The dispatcher then reads
// the role's `branches` map to pick the next role.
//
// Branch keys are intentionally short — the parser only accepts
// /^[a-z0-9_-]{1,64}$/ — and the role's prompt enumerates the allowed keys
// so a free-form "next: lgtm" silently falls through to the state machine
// (the dispatcher only honors keys present in `branches`).
export const triageRole: RoleConfig = {
  role: "triage",
  displayName: "Triage",
  modelTier: "default",
  // Per CLAUDE.md non-negotiable #1, the Local Claude Code runner is the
  // default everywhere. Triage runs on the operator's Pro/Max subscription
  // by default; switch to "api" explicitly only for multi-tenant serving.
  runnerPolicy: "local-cc",
  // Triage does NOT carry the ticket forward on its own; the dispatcher
  // decides the next role based on the branch key. Staying in `in_progress`
  // is fine — the next role (qa or tech_lead) drives the next transition.
  onSuccessStatus: "in_progress",
  // The canonical branch map for the demo. A real tenant would extend this
  // with more keys (e.g. `infra_change → devops`, `docs_only → techwriter`)
  // — the dispatcher honors any key present here.
  branches: {
    small_change: "qa",
    large_change: "tech_lead",
  },
  systemPrompt:
    "You are a senior triage reviewer for a production agent platform. You read a refined " +
    "ticket (PM has already produced a description + acceptance criteria) and decide whether " +
    'the proposed change is low-risk ("small_change") or high-risk ("large_change"). ' +
    "The ticket UUID is provided in the user message as `ticketId`.\n\n" +
    "Heuristic — call it large_change if ANY of:\n" +
    "  - touches authentication, authorization, RLS, or any security boundary\n" +
    "  - changes a public API contract / schema field consumed by other systems\n" +
    "  - introduces or modifies a migration that alters existing tables\n" +
    "  - spans more than ~3 files or > ~200 LOC of logic\n" +
    "  - introduces a new external dependency or vendor SDK\n" +
    "  - touches money/cost paths, payment, or anything irreversible\n" +
    "  - involves cascading deletes, lock semantics, or concurrency primitives\n" +
    "Otherwise call it small_change (typo fixes, copy edits, single-file feature flag toggles, " +
    "localised refactors, internal-only naming changes, single-file test additions).\n\n" +
    "Above the branch-signal line required by the safety contract below, write 2–4 sentences " +
    "of rationale citing the specific factors from the heuristic that drove your call.",
  // Phase 4 split. The risk heuristic and the rationale length are STYLE — an
  // operator tuning what counts as large_change for his codebase is exactly the
  // use this feature exists for. The output CONTRACT is not style: the
  // `branch-signal` parser and the dispatcher's `branches` map read those two
  // literal strings, and "do NOT call devpilot_move_ticket" is what keeps this
  // role from driving a transition the dispatcher owns.
  safetyContract:
    "OUTPUT FORMAT — your assistant message MUST end with one of these exact lines on its " +
    "own line, with no trailing punctuation:\n" +
    "  next: small_change\n" +
    "  next: large_change\n" +
    "Do NOT use any other branch key — anything other than those two strings is treated as " +
    '"no decision" and the dispatcher falls back to the default routing.\n\n' +
    "Do NOT call devpilot_move_ticket — the dispatcher reads your branch signal and routes the " +
    "ticket itself. You MAY call devpilot_comment to leave your rationale as a durable comment, " +
    "but the binding signal is the `next: <key>` line in your final assistant text.",
};
