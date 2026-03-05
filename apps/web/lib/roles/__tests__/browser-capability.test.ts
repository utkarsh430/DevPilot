// The browser capability cannot be silently dropped, and cannot be silently
// acquired.
//
// The bug this file guards against already happened once, in the widest
// possible form: the runner handed all ~55 roles 24 `mcp__playwright__browser_*`
// tools and NOT ONE prompt mentioned them, so the capability was live and
// invisible for its entire existence. Nothing failed — an invisible capability
// produces no error, just agents that never reach for it. That is precisely the
// class of defect a test has to carry, because review will not catch it twice.
//
// So this asserts BOTH directions against the live `ROLES` catalog:
//   • every role in `BROWSER_AWARE_ROLES` actually says so in the prompt a run
//     receives — a prompt rewrite that drops the block turns this red;
//   • every role outside it stays silent — the set is a curation decision, and
//     a role that drifts into discussing the browser has escaped it.
//
// Assertions run against the COMPOSED prompt (`applySafetyContract`), not the
// raw `systemPrompt` field, because the composed string is what dispatch and
// the eval snapshots use. Testing the constant instead would pass even if the
// block were spliced into a field nothing reads.

import { describe, expect, it } from "vitest";
import { ROLES } from "@/lib/roles/index";
import { applySafetyContract } from "@/lib/roles/safety-contract";
import {
  BROWSER_AWARE_ROLES,
  BROWSER_CAPABILITY_BLOCK,
  isBrowserAwareRole,
} from "@/lib/roles/browser-capability";
import { extractToolingClaims } from "@/lib/roles/prompt-tooling";

// The MCP namespace is the marker, deliberately NOT the word "browser".
// Several excluded roles legitimately use that word for other things —
// `appsec_engineer` says "browser-only flaw", `frontend_engineer` says "browser
// APIs", `it_admin` talks about browser policy — so a word-level check would be
// simultaneously noisy and unable to tell awareness from coincidence. The tool
// namespace appears only when a prompt is genuinely describing these tools.
const MARKER = "mcp__playwright__browser_";

function composed(slug: string): string {
  const role = ROLES[slug as keyof typeof ROLES];
  return applySafetyContract(role.systemPrompt, role.safetyContract);
}

describe("BROWSER_AWARE_ROLES membership", () => {
  it("every member is a real role in the live catalog", () => {
    // A slug typo would otherwise disable the capability for that role while
    // every other assertion here still passed.
    for (const slug of BROWSER_AWARE_ROLES) {
      expect(Object.keys(ROLES), `${slug} is not in ROLES`).toContain(slug);
    }
  });

  it("every member's composed prompt describes the browser tools", () => {
    for (const slug of BROWSER_AWARE_ROLES) {
      expect(composed(slug), `${slug} lost the browser capability block`).toContain(MARKER);
    }
  });

  it("no role outside the set mentions the browser tools", () => {
    const leaked = Object.keys(ROLES).filter(
      (slug) => !isBrowserAwareRole(slug) && composed(slug).includes(MARKER),
    );
    expect(leaked, `roles describe the browser tools without being in the set: ${leaked}`).toEqual(
      [],
    );
  });

  it("covers the producers and reviewers of web UI, and not the document roles", () => {
    // Pins the actual curation decision, not just its self-consistency: the
    // three assertions above all pass for an EMPTY set. Adding or removing a
    // role should be a deliberate edit here with a reason in the PR.
    expect([...BROWSER_AWARE_ROLES].sort()).toEqual([
      "engineer",
      "frontend_engineer",
      "fullstack_engineer",
      "qa",
      "qa_automation_engineer",
      "sdet",
      "verifier",
    ]);
  });
});

describe("BROWSER_CAPABILITY_BLOCK content", () => {
  it("states what the tools are NOT, not only what they are", () => {
    // The failure mode this guards is worse than ignorance: an agent that
    // believes it wrote a durable regression test when it only clicked through
    // a flow once leaves a ticket marked covered with no coverage behind it.
    expect(BROWSER_CAPABILITY_BLOCK).toContain("does NOT produce a committed");
    expect(BROWSER_CAPABILITY_BLOCK).toMatch(/never describe a browser session as test coverage/i);
  });

  it("tells the agent to read tool schemas rather than fixing call signatures", () => {
    // Verified against the pinned server: in @playwright/mcp 0.0.78
    // `browser_click` takes a flat `target` string, while the widely-documented
    // shape is a nested `{element, ref}` object. A prompt that spelled out
    // arguments would be confidently wrong at the next version bump.
    expect(BROWSER_CAPABILITY_BLOCK).toMatch(/schema/i);
  });

  it("says the tools need something already serving the page", () => {
    expect(BROWSER_CAPABILITY_BLOCK).toMatch(/do not build or start anything/i);
  });

  it("makes no `pnpm exec` tooling claim", () => {
    // Interop with `__tests__/prompt-tooling.test.ts`, which fails on any
    // `pnpm exec <bin>` the workspace does not declare. This block must stay
    // green there by construction — never by being exempted, and never by
    // naming a binary to work around the guard.
    expect(extractToolingClaims(BROWSER_CAPABILITY_BLOCK)).toEqual([]);
  });
});

describe("isBrowserAwareRole", () => {
  it("is false for a null, undefined, or unknown role", () => {
    // A custom JD-synthesized role cannot appear in a static set, so the
    // default must be "not aware" rather than a crash or an accidental yes.
    expect(isBrowserAwareRole(null)).toBe(false);
    expect(isBrowserAwareRole(undefined)).toBe(false);
    expect(isBrowserAwareRole("")).toBe(false);
    expect(isBrowserAwareRole("some_custom_role")).toBe(false);
  });

  it("is true for a member", () => {
    expect(isBrowserAwareRole("qa")).toBe(true);
  });
});
