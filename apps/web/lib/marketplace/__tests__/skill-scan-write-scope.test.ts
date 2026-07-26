// "The scan writes nothing."
//
// That is the load-bearing claim of this feature, and it is the one an ordinary
// unit test cannot make: a test that exercises the scan and observes no write
// proves only that THAT path did not write, not that no path can. So this file
// SOURCE-SCANS the scan modules and the action beside them, the way
// `lib/skills/__tests__/authoring-assist-write-scope.test.ts` does — and for the
// same reason, since `scan-actions.ts` is `"use server"` and cannot load under
// Vitest at all, which is precisely the gap a bug would live in.
//
// It also pins the properties that can regress silently: no persistence layer
// was added, the tenant id comes from the SESSION, the model call goes through
// the tenant-aware adapter rather than a vendor SDK, and the anti-steering
// composition is still a concatenation.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB_ROOT = join(__dirname, "..", "..", "..");
const REPO_ROOT = join(WEB_ROOT, "..", "..");

function read(rel: string): string {
  return readFileSync(join(WEB_ROOT, rel), "utf8");
}

/** Strip comments so a table name inside prose is not read as a query. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const SCAN = "lib/marketplace/skill-scan.ts";
const SCAN_SERVER = "lib/marketplace/skill-scan.server.ts";
const STORE = "lib/marketplace/skill-scan-store.ts";
const ACTIONS = "lib/marketplace/scan-actions.ts";
const REPORT = "components/marketplace/skill-scan-report.tsx";

describe("the scan touches no table", () => {
  it.each([SCAN, SCAN_SERVER])("%s performs no database access at all", (rel) => {
    const src = code(rel);
    // Stronger than a correctly-scoped read: there is no query here for a
    // tenant filter to be missing from.
    expect(src).not.toMatch(/\.from\s*\(/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
    expect(src).not.toContain("supabaseService");
    expect(src).not.toContain("supabaseServer");
  });

  it("the store reads and never writes", () => {
    const src = code(STORE);
    expect(src).toMatch(/\.select\s*\(/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
  });

  it("the action writes nothing and reaches no writer", () => {
    const src = code(ACTIONS);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
    // It never builds a query itself — the one read goes through the store,
    // which is where the tenant predicates live and are tested.
    expect(src).not.toMatch(/\.from\s*\(/);
    for (const writer of [
      "createOwnedSkill",
      "updateOwnedSkill",
      "deleteOwnedSkill",
      "installSkillAction",
      "publishSkillAction",
      "revalidatePath",
    ]) {
      expect(src, `the scan must not reach ${writer}`).not.toContain(writer);
    }
  });

  it("no migration was added for this feature", () => {
    // The report is a function of a body the operator is looking at right now.
    // Persisting it would create a second thing that can go stale against the
    // row it describes, and re-running is cheap and always current. If a scan
    // results table ever IS wanted, this test failing is the prompt to justify
    // it in the PR rather than let it arrive quietly.
    const dir = join(REPO_ROOT, "supabase", "migrations");
    const named = readdirSync(dir).filter((f) => /scan/i.test(f));
    expect(named).toEqual([]);
  });
});

describe("the action's inputs and routing", () => {
  const src = code(ACTIONS);

  it("derives the tenant from the session, never from the caller", () => {
    expect(src).toContain("await requireUser()");
    expect(src).toContain("await requireTenantId()");
    // The input schema names exactly the one client-supplied field; a tenantId
    // among them would be the bug.
    const schema = src.slice(src.indexOf("const ScanInput"), src.indexOf("export async function"));
    expect(schema).toContain("skillId");
    expect(schema).not.toContain("tenantId");
    expect(schema).not.toContain("body");
  });

  it("loads the row through the tenant-scoped store, passing the session tenant", () => {
    expect(src).toMatch(/loadScannableSkill\(/);
    expect(src).toMatch(/tenantId,/);
    expect(src).toMatch(/defaultSkillScanDeps\(tenantId\)/);
  });

  it("scans the body it LOADED, never a body supplied by the caller", () => {
    // A caller-supplied body would make the tenant-scoped read decorative and
    // turn the scan into a free-text LLM endpoint.
    expect(src).toMatch(/body:\s*skill\.body/);
  });
});

describe("the model call stays behind the adapter", () => {
  const server = code(SCAN_SERVER);

  it("routes through `generateObjectForTenant`, never a vendor SDK", () => {
    expect(server).toContain("generateObjectForTenant");
    // A direct `generateObject` crashes in `claude_code` auth mode, which is
    // the default; a vendor SDK breaks the adapter boundary outright.
    expect(server).not.toMatch(/from "ai"/);
    expect(server).not.toMatch(/@ai-sdk\//);
    expect(server).not.toMatch(/@anthropic-ai\//);
  });

  it("fences the body rather than passing it raw to the model", () => {
    expect(server).toContain("fenceUntrustedOutput");
  });
});

describe("the anti-steering composition is still structural", () => {
  const src = code(SCAN);

  it("static findings are computed before the reviewer is called", () => {
    const staticAt = src.indexOf("const staticFindings = scanSkillBodyStatic(body)");
    const reviewAt = src.indexOf("await deps.review(");
    expect(staticAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(staticAt);
  });

  it("merging concatenates and nothing filters a static finding", () => {
    const fn = src.slice(
      src.indexOf("export function mergeScanFindings"),
      src.indexOf("// ── The DI'd entry point"),
    );
    expect(fn).toContain("[...staticFindings, ...reviewFindings]");
    // A filter, find, splice or predicate here would hand the steerable half a
    // way to remove a deterministic finding, and the module header's central
    // claim would become false.
    for (const escape of [".filter(", ".splice(", ".find(", "delete "]) {
      expect(fn, `mergeScanFindings must not ${escape}`).not.toContain(escape);
    }
  });

  it("the reviewer's schema has no verdict, score or confidence field", () => {
    const schema = src.slice(
      src.indexOf("export const SkillReviewSchema"),
      src.indexOf("export type SkillReviewReply"),
    );
    expect(schema.length).toBeGreaterThan(0);
    // Matched as an object KEY, not as a substring: the schema's own describe
    // text legitimately contains the sentence "There is no way to say a skill
    // is safe", and banning the word would forbid saying so.
    for (const field of [
      "verdict",
      "score",
      "confidence",
      "safe",
      "isSafe",
      "severity",
      "risk",
      "summary",
      "recommendation",
    ]) {
      expect(schema, `the reviewer must not be able to assert "${field}"`).not.toMatch(
        new RegExp(`\\b${field}\\s*:`, "i"),
      );
    }
  });

  it("the reviewer is never shown the static findings", () => {
    const call = src.slice(src.indexOf("await deps.review("), src.indexOf("if (!res.ok)"));
    expect(call).not.toContain("staticFindings");
    expect(call).not.toContain("findings");
  });
});

describe("the rendered result has no verdict affordance", () => {
  // Comments stripped — the file's own header explains that it renders no
  // score, and a substring scan would read that explanation as the thing.
  const src = code(REPORT);

  it("renders no score, grade or severity", () => {
    for (const token of [
      "severity",
      "score",
      "grade",
      "risk level",
      "CheckCircle",
      "ShieldCheck",
    ]) {
      expect(src, `the panel must not render ${token}`).not.toContain(token);
    }
  });

  it("takes its wording from `describeScanOutcome` rather than inlining it", () => {
    // Keeps every verdict-adjacent sentence pinned by a test instead of loose
    // in a component where a styling change can drift it into reassurance.
    expect(src).toContain("describeScanOutcome");
    expect(src).toContain("outcome.limitation");
  });
});
