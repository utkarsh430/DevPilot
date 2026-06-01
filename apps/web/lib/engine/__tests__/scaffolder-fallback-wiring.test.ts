// The fallback is REGISTERED, not just written.
//
// An Inngest function that is defined but missing from the `functions` array in
// `app/api/inngest/route.ts` type-checks, imports cleanly, and silently never
// runs - the classic miss called out in docs/runbooks/add-inngest-function.md.
// Every other test in this feature mocks `createFunction`, so a de-registration
// would leave all of them green while the empty-repo guarantee quietly died: an
// abandoned plan would leave the repo empty forever, and nothing would say so.
//
// The route module can't be imported here (it pulls the whole engine and Next
// server APIs), so this reads the source - the same posture as
// scaffolder-single-creator.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE = fileURLToPath(new URL("../../../app/api/inngest/route.ts", import.meta.url));

describe("scaffolderFallbackFn is served", () => {
  const source = readFileSync(ROUTE, "utf8");

  it("is imported by the inngest route", () => {
    expect(source).toMatch(
      /import\s*\{\s*scaffolderFallbackFn\s*\}\s*from\s*"@\/lib\/engine\/scaffolder-fallback"/,
    );
  });

  it("is listed in the served `functions` array", () => {
    const functionsArray = source.match(/const functions = \[([\s\S]*?)\];/);
    expect(functionsArray).not.toBeNull();
    expect(functionsArray![1]).toContain("scaffolderFallbackFn");
  });

  it("is triggered by the event the create action actually emits", () => {
    // The two halves of the contract have to name the same string, and nothing
    // else checks that: a typo on either side is a function that never fires.
    const fallback = readFileSync(
      fileURLToPath(new URL("../scaffolder-fallback.ts", import.meta.url)),
      "utf8",
    );
    const createAction = readFileSync(
      fileURLToPath(new URL("../../../app/(app)/projects/actions.ts", import.meta.url)),
      "utf8",
    );
    expect(fallback).toContain('{ event: "project/scaffolder-held" }');
    expect(createAction).toContain('name: "project/scaffolder-held"');
  });
});
