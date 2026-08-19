// Presentation vocabulary shared by BOTH lesson views (the card review stack and
// the table). Extracted so a scope colour or a mistake-type label can never mean
// one thing in one view and something else in the other — the operator switches
// between them constantly and the two must read as one surface.

import type { LessonScope } from "@/lib/learning/extract";

export const SCOPE_TONE: Record<LessonScope, "info" | "violet" | "ok"> = {
  global: "info",
  role: "violet",
  user: "ok",
};

/** Snake-case slug → a label a person reads: `code_quality` → "Code quality".
 *  Used for the free-text category and role-slug facets, where CSS `capitalize`
 *  alone leaves the underscore visible ("Code_quality"). */
export function humanizeSlug(slug: string): string {
  const spaced = slug.replace(/_/g, " ").trim();
  return spaced.length === 0 ? slug : spaced[0]!.toUpperCase() + spaced.slice(1);
}

/** Human labels for `agent_mistakes.type`. An unknown type falls through to the
 *  raw slug at the call site rather than being hidden. */
export const MISTAKE_LABEL: Record<string, string> = {
  run_failed: "Run failed",
  verification_fail: "Verification failed",
  qa_reject: "QA rejected",
  gate_refusal: "Gate refusal",
  human_correction: "Human correction",
};
