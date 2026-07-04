// EXACTLY ONE CREATOR - the #79 invariant, as a red test rather than a comment.
//
// PR #79 ("Part D") fixed a duplicate-scaffolder bug whose root cause was a
// SECOND creator: the plan consolidator filed its own `project_scaffolder`
// ticket on every successful plan build, redundant with the one the create
// action had already filed. The plan-informed scaffolder deliberately did NOT
// re-open that door - the create action still inserts the only automated row,
// and the plan commit / discard / abandonment fallback merely RELEASE it.
//
// SCOPE, stated precisely, because the first version of this test overstated it:
// the invariant is that no AUTOMATED path creates a scaffolder row. A human can
// still deliberately file one from the board's New-ticket dialog (it offers the
// whole role catalog) - that is an operator decision, not a duplicate the engine
// inflicted on them, and it is unchanged by this feature.
//
// WHAT THIS SCANS, and why it is not the obvious regex. A first cut matched only
// the literal `requested_role: "project_scaffolder"`, which any of these would
// walk straight past:
//
//   • the variable form  - `requested_role: p.requested_role` (exactly how
//     commitPlanAction could file one, since the planner may propose the slug),
//   • a renamed constant - `requested_role: SOME_OTHER_ALIAS`,
//   • insert-then-UPDATE - insert a plain ticket, then `update({requested_role})`.
//
// So the rule is coarser and harder to slip past: ANY file that both (a) names
// the scaffolder role at all - literal or via SCAFFOLDER_ROLE_SLUG - and (b)
// writes to `tickets`, must be on the allowlist below WITH a reason. That
// catches all three evasions, because every one of them has to name the role
// somewhere in the file that does the write.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SCAFFOLDER_ROLE_SLUG } from "@/lib/plan/scaffolder";

const WEB_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCAN_DIRS = ["app", "lib"];
const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__"]);

/** Does this file name the scaffolder role at all? */
const NAMES_ROLE = new RegExp(`SCAFFOLDER_ROLE_SLUG|["'\`]${SCAFFOLDER_ROLE_SLUG}["'\`]`);

/** Does this file write to the tickets table? */
const WRITES_TICKETS = /\.from\(\s*["'`]tickets["'`]\s*\)[\s\S]{0,400}?\.(insert|update|upsert)\(/;

/**
 * Strip comments before scanning. The rule is about what the CODE does; a file
 * that explains why it refuses to file a scaffolder has to be able to say the
 * word. Crude on purpose - it only has to be good enough that prose can't
 * trigger the guard, and a false positive here is a loud test, not a silent
 * hole.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Files allowed to do both. Every entry is a decision, not a rubber stamp - if
 * a new file shows up here, the question is "why is a second thing touching
 * scaffolder rows?", not "how do I make the test pass".
 */
const ALLOWED = new Map<string, string>([
  [
    "app/(app)/projects/actions.ts",
    "THE creator. The only automated path that may insert a scaffolder row.",
  ],
  [
    "lib/plan/scaffolder-release.server.ts",
    "The release seam. Updates status/plan_hold on the EXISTING row; never inserts " +
      "(pinned by scaffolder-release.test.ts).",
  ],
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(full)) yield full;
  }
}

function filesNamingRoleAndWritingTickets(): string[] {
  const hits: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(WEB_ROOT, dir))) {
      const src = stripComments(readFileSync(file, "utf8"));
      if (NAMES_ROLE.test(src) && WRITES_TICKETS.test(src)) {
        hits.push(relative(WEB_ROOT, file));
      }
    }
  }
  return hits.sort();
}

describe("the scaffolder has exactly one automated creator", () => {
  it("only the allowlisted files both name the scaffolder role and write tickets", () => {
    expect(filesNamingRoleAndWritingTickets()).toEqual([...ALLOWED.keys()].sort());
  });

  it("the PLAN flow never names the scaffolder role at all", () => {
    // Not a style rule - it is what keeps the allowlist above meaningful. The
    // plan actions reject the role through `isScaffolderRole`, so the file that
    // bulk-inserts tickets never contains the slug and can never be the file
    // that quietly starts stamping it.
    const planActions = stripComments(
      readFileSync(join(WEB_ROOT, "app/(app)/plan/actions.ts"), "utf8"),
    );
    expect(planActions).not.toMatch(new RegExp(`["'\`]${SCAFFOLDER_ROLE_SLUG}["'\`]`));
    expect(planActions).toContain("isScaffolderRole");
  });

  it("the guard would catch a variable-form insert", () => {
    // Proving the regex, not the tree: this is the shape the old literal-only
    // scan walked past - `commitPlanAction` copying a proposed role through.
    const evasion = `
      const role = p.requested_role; // could be "project_scaffolder"
      await supabase.from("tickets").insert({ requested_role: role });
    `;
    expect(NAMES_ROLE.test(evasion) && WRITES_TICKETS.test(evasion)).toBe(true);
  });

  it("the guard would catch an insert-then-UPDATE", () => {
    const evasion = `
      const { data } = await supabase.from("tickets").insert({ title: "x" }).select("id");
      await supabase
        .from("tickets")
        .update({ requested_role: SCAFFOLDER_ROLE_SLUG })
        .eq("id", data[0].id);
    `;
    expect(NAMES_ROLE.test(evasion) && WRITES_TICKETS.test(evasion)).toBe(true);
  });
});
