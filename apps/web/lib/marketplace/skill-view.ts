// Marketplace review rules — the pure half of the skill preview surface.
//
// WHY THIS IS A SEPARATE MODULE, AND NOT INLINE JSX. The marketplace page
// carries one standing instruction — "review the body before installing" — and
// that instruction is the entire safety story for a skill: a skill body is
// PROMPT CONTENT that `mergeSkillsIntoSystemPrompt` splices into a role's
// system prompt at dispatch (`lib/skills/merge.ts`). Whether an operator can
// actually carry that instruction out comes down to a handful of judgements —
// which roles does this attach to, when does it fire, does the copy already
// installed still match the public source, may I edit this — and every one of
// them is a rule, not a layout. Rules belong somewhere a test can reach them.
//
// The single most important rule here is EMPTY TARGETS MEANS EVERY ROLE.
// `keywordFilter` (`lib/skills/select.ts`) reads it that way:
//
//     const targetHit = targets.length === 0 || targets.includes(role);
//
// so a skill with no targets is the BROADEST-reach skill in the catalog — it is
// eligible for every dispatch of every role. The card used to render an empty
// chip row for exactly that case, which reads as "attaches to nothing": the
// widest-reaching skill in the catalog looked like the narrowest. That is an
// inversion of the fact an operator most needs before installing prompt text,
// so `describeSkillReach` names the all-roles case explicitly and
// `__tests__/skill-view.test.ts` pins it.

import type { SkillRow } from "@/lib/skills/types";

/**
 * Where a skill row came from, which is what decides who may edit it.
 *
 *  - `public`    — `tenant_id IS NULL`. The first-party catalog. Read-only for
 *                  every tenant; the install flow clones it rather than
 *                  mutating it.
 *  - `installed` — tenant-owned AND `installed_from_skill_id` set. A clone this
 *                  tenant made from a public row. Editable in principle, but it
 *                  has a source to be compared against.
 *  - `authored`  — tenant-owned with no source. This tenant wrote it.
 *
 * `installed` and `authored` are BOTH `tenant_id != null` and used to render
 * identically, which is why the distinction is drawn here rather than left to
 * a truthiness check at each call site.
 */
export type SkillOrigin = "public" | "installed" | "authored";

export function classifySkillOrigin(
  skill: Pick<SkillRow, "tenant_id" | "installed_from_skill_id">,
): SkillOrigin {
  if (skill.tenant_id === null) return "public";
  return skill.installed_from_skill_id ? "installed" : "authored";
}

/**
 * May this tenant edit this row?
 *
 * Ownership is the whole rule: a row belongs to the tenant iff its `tenant_id`
 * matches. Public rows (`tenant_id IS NULL`) are never editable from the app —
 * `installSkillAction` refuses to touch them and the RLS policies in
 * `20260603090000_m11_marketplace.sql` make them read-only for anything that is
 * not `service_role`. Rendering an Edit affordance on one would offer a route
 * that cannot exist.
 *
 * A null `tenantId` (no resolved tenant) never owns anything — the `=== null`
 * guard is deliberate rather than a `!tenantId` truthiness test, so an empty
 * string can never accidentally match a row whose tenant_id is also empty.
 *
 * The explicit public-row early return is belt-and-braces: string equality
 * against a non-empty tenant id already excludes `null`. It is kept because
 * "public rows are never editable" is a rule worth stating at the top of the
 * function rather than leaving as a consequence of how comparison happens to
 * behave — a later change to how ownership is compared should not be able to
 * make public rows editable as a side effect.
 */
export function canEditSkill(
  skill: Pick<SkillRow, "tenant_id">,
  tenantId: string | null | undefined,
): boolean {
  if (skill.tenant_id === null) return false;
  if (tenantId === null || tenantId === undefined || tenantId === "") return false;
  return skill.tenant_id === tenantId;
}

/**
 * Which roles a skill attaches to, said out loud.
 *
 * `allRoles` is the load-bearing field. See the module header: an empty
 * `targets` array is not "no roles", it is EVERY role, and the UI must say so.
 */
export type SkillReach = {
  /** True when `targets` is empty — the skill is eligible for every role. */
  allRoles: boolean;
  /** The explicit role slugs, deduped and sorted. Empty when `allRoles`. */
  roles: string[];
};

export function describeSkillReach(targets: unknown): SkillReach {
  const list = Array.isArray(targets)
    ? targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  if (list.length === 0) return { allRoles: true, roles: [] };
  return { allRoles: false, roles: Array.from(new Set(list)).sort() };
}

/**
 * The trigger keywords, normalised.
 *
 * Triggers are the OTHER half of the selection rule and were surfaced nowhere:
 * `keywordFilter` scores a skill by how many of its triggers appear in the
 * ticket text, so "when does this fire" is unanswerable without them. An empty
 * trigger list is meaningful too — the skill is eligible on role alone, with no
 * keyword narrowing at all — so the caller gets the empty array and states it.
 */
export function describeSkillTriggers(triggers: unknown): string[] {
  if (!Array.isArray(triggers)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of triggers) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * How the copy installed in this tenant relates to the public source.
 *
 *  - `not_installed` — nothing to compare.
 *  - `identical`     — the installed clone still matches the public body.
 *  - `differs`       — it does not. Either the public row moved on after the
 *                      install, or the tenant edited its clone. Both are real
 *                      and both matter: the "Installed" pill implies parity and
 *                      the operator has no other way to learn it is wrong.
 *
 * Compared on the BODY alone, because the body is the thing that reaches the
 * model. Version/manifest drift without a body change does not alter what an
 * agent is told, and reporting it as a difference would train the operator to
 * dismiss the signal.
 */
export type InstallComparison = "not_installed" | "identical" | "differs";

export function compareWithInstalled(
  publicBody: string,
  installed: Pick<SkillRow, "body"> | null | undefined,
): InstallComparison {
  if (!installed) return "not_installed";
  return installed.body === publicBody ? "identical" : "differs";
}

/**
 * Cheap size facts for the body, so the card can set an expectation before the
 * operator opens the preview ("this is 4,200 characters" is the difference
 * between skimming and reading).
 */
export function describeBodySize(body: string): { chars: number; lines: number } {
  if (body.length === 0) return { chars: 0, lines: 0 };
  return { chars: body.length, lines: body.split("\n").length };
}

const ORIGIN_LABEL: Record<SkillOrigin, string> = {
  public: "Public catalog",
  installed: "Installed copy",
  authored: "Authored here",
};

export function originLabel(origin: SkillOrigin): string {
  return ORIGIN_LABEL[origin];
}
