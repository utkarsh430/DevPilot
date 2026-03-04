// Which roles are TOLD they can drive a real browser, and what they are told.
//
// THE DEFECT THIS CLOSES. `apps/runner/src/claude.ts` wires Microsoft's
// `@playwright/mcp` (pinned 0.0.78 in `apps/runner/package.json`) as MCP server
// `playwright` and spreads its 24 `browser_*` tools into `AGENT_TOOLS_CSV`
// UNGATED — so every one of the ~55 roles receives
// `mcp__playwright__browser_navigate`, `browser_click`, `browser_snapshot`,
// `browser_console_messages`, `browser_evaluate` and the rest at every
// dispatch, and chromium is installed on the runner host. Not one role prompt
// mentioned any of it. A capability handed over and never referenced is a
// capability nobody reaches for: agents were asserting that a UI change worked
// from reading the diff, when they could have opened the page and looked.
//
// ─── The two capabilities this file refuses to conflate ────────────────────
//
// PR #148 corrected a real defect in `qa_automation_engineer` and `sdet` (they
// instructed a Playwright test-runner command against a repo that declares no
// such runner) and its core fix — detect the stack, never assert one; no
// hardcoded repo paths — is right and is preserved. But it OVER-CONCLUDED,
// collapsing two different capabilities into one "browser is unavailable":
//
//   • Write a PERSISTENT `.spec` suite run by a browser test runner.
//     GENUINELY ABSENT here: `@playwright/test` is not a declared dependency of
//     `apps/web` (or any workspace package). Escalate — adding a test
//     dependency is an operator decision. This is what #148 correctly found.
//
//   • Drive a real browser NOW to see whether a page works.
//     FULLY AVAILABLE, via the MCP tools above. Just do it.
//
// The second was collateral damage. An agent asked "does this page actually
// work" escalated to a human when it could have answered the question itself.
//
// ─── Membership rule ───────────────────────────────────────────────────────
//
// Every role technically HAS the tools; that is not a reason to discuss them in
// every prompt. Prompt text is a standing cost paid on every dispatch of that
// role, and instructions a role will never act on dilute the ones it will.
//
// A role is in this set when driving a browser changes what it DELIVERS or what
// VERDICT it renders on web UI. Not when it could conceivably find a use.
//
// The error is asymmetric in the opposite direction from
// `lib/roles/code-producing.ts`, so the tie-break is too. There, an over-broad
// set WEDGES a role; here, an over-broad set merely adds noise, while an
// over-narrow one recreates exactly the invisible-capability bug above. So this
// set errs toward telling a role that plausibly verifies web UI — but it still
// has to pass the deliverable-or-verdict test, or it is noise with extra steps.
//
// DELIBERATELY EXCLUDED, each considered:
//   • `technical_writer`, `designer`, `ux_designer`, `ui_designer`,
//     `product_designer`, `ux_researcher` — their deliverable is a DOCUMENT
//     (spec, wireframe, token set), not a verdict on running code.
//   • `backend_engineer` — no UI surface. An HTTP API is exercised more
//     directly with Bash than through a browser; a browser adds a rendering
//     engine between the agent and the thing under test.
//   • `mobile_engineer` — a native app is not a web page.
//   • `appsec_engineer` — the strongest deferred candidate. A DOM-only flaw
//     (e.g. reflected XSS) genuinely can only be confirmed in a browser. But
//     that role's stated deliverable is a COMMITTED test that exercises the
//     exploit — i.e. the persistent-suite capability that is absent here — and
//     driving a browser to probe for vulnerabilities is a different posture
//     than driving one to confirm a page renders. Worth revisiting on its own
//     evidence rather than folding in here.
//   • `devops` — the other near-miss. It deploys and reports a URL, and "the
//     deploy succeeded" is not quite "the deployed page loads". Deferred
//     because its prompt already carries a long deploy safety contract and
//     widening it belongs in a change that owns that path.
//
// Widening this set later is a one-line change here plus the shared block
// below; `__tests__/browser-capability.test.ts` asserts both directions against
// the live `ROLES` catalog, so a future prompt rewrite cannot silently drop the
// capability again, and a role cannot gain it by accident.

// IMPORT THIS RELATIVELY, NOT THROUGH THE `@/` ALIAS. `tests/evals/
// snapshot-prompts.mjs` runs under bare `node --import tsx` from the repo root,
// where no `apps/web` tsconfig is loaded and the alias does not resolve; it
// imports each role module by a plain relative path and relies on role files
// being loadable standalone. That held only because every role file's imports
// were `import type` (erased by tsx) — this is the first shared VALUE import
// into a role prompt, so `@/lib/roles/browser-capability` fails snapshot
// regeneration with "Cannot find module" while typechecking and testing fine.
// A relative specifier resolves in both. This module deliberately imports
// nothing, so it stays standalone-loadable too.

/**
 * Roles whose prompts describe the browser tools.
 *
 * Asserted against the live `ROLES` catalog by
 * `lib/roles/__tests__/browser-capability.test.ts` — both that every member
 * exists and mentions the tools, and that every non-member does not.
 */
export const BROWSER_AWARE_ROLES: ReadonlySet<string> = new Set([
  // Code producers whose output is a web surface. `engineer` is the primary
  // producer and builds most web UI; the two specialists own it outright.
  "engineer",
  "frontend_engineer",
  "fullstack_engineer",
  // Reviewers that render a verdict on that surface. `qa` approves or rejects
  // producer output, and reading a diff cannot tell it whether the page
  // renders. `verifier` exists specifically to prove the app ACTUALLY runs
  // rather than merely that its tests pass — the browser is the most direct
  // evidence that role could possibly gather.
  "qa",
  "verifier",
  // Test authors. Both were told by #148 that the browser layer was
  // unavailable; for the interactive half that was wrong, and these two are
  // the roles most likely to act on the correction.
  "qa_automation_engineer",
  "sdet",
]);

/** Is `role` a role whose prompt describes the browser tools? */
export function isBrowserAwareRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return BROWSER_AWARE_ROLES.has(role);
}

/**
 * The ONE description of the browser capability, spliced into each member's
 * `systemPrompt`. Single-sourced so seven prompts cannot drift into seven
 * different accounts of what these tools are — in particular, of what they are
 * NOT.
 *
 * Three properties are load-bearing.
 *
 * (1) IT NAMES TOOLS, NEVER CALL SIGNATURES. The pinned server's argument
 *     shapes are not stable and are not ours: in 0.0.78 `browser_click` takes a
 *     flat `target` string, where the widely-documented shape is a nested
 *     `{element, ref}` object. A prompt that spelled out arguments would be
 *     wrong at the next bump and wrong in the confident way — so it tells the
 *     agent to read the tool's own schema, which is always current.
 *
 * (2) IT STATES WHAT THE TOOLS ARE NOT, as prominently as what they are. An
 *     agent that believes it wrote a durable regression test when it only
 *     clicked through a flow once has produced a worse outcome than one that
 *     never knew the tools existed: the first leaves a ticket marked covered
 *     with no coverage behind it.
 *
 * (3) IT REQUIRES A RUNNING TARGET. These tools drive a browser, not a
 *     codebase; with no URL serving the change there is nothing to navigate to,
 *     and an agent that does not know this burns a turn discovering it.
 *
 * Every tool named below was confirmed present in the pinned server's own
 * `tools/list` response (all 24 names matched `BROWSER_TOOLS` in
 * `apps/runner/src/claude.ts` exactly). That check cannot be automated from
 * here: `apps/web` and `apps/runner` share no constants module — the same
 * constraint that makes `AGENT_ENV_DENY_KEYS` a hand-kept web-side mirror — and
 * adding a mirror of the tool list would introduce a second thing to drift. If
 * the pinned `@playwright/mcp` version moves, re-verify the names here against
 * a `tools/list` handshake rather than trusting this comment.
 *
 * Contains no `pnpm exec <bin>` claim, so `__tests__/prompt-tooling.test.ts`
 * (which fails on any binary a workspace does not declare) stays green by
 * construction rather than by exemption — and must never be worked around by
 * naming a binary here.
 */
export const BROWSER_CAPABILITY_BLOCK =
  "YOU CAN DRIVE A REAL BROWSER.\n" +
  "You have `mcp__playwright__browser_*` tools backed by a real headless " +
  "Chromium: `browser_navigate`, `browser_snapshot` (accessibility tree of " +
  "the live page), `browser_click`, `browser_type`, `browser_fill_form`, " +
  "`browser_evaluate` (run JS in the page), `browser_console_messages`, " +
  "`browser_network_requests`, and `browser_take_screenshot`, among others. " +
  "These are real: real navigation, real DOM, real console output, real " +
  "network activity. Read each tool's own schema before calling it rather " +
  "than assuming its arguments — the shapes belong to the upstream server and " +
  "change between versions.\n" +
  "WHAT THIS IS NOT. Driving the browser does NOT produce a committed " +
  "regression test. Nothing you do with these tools persists into the repo or " +
  "runs again in CI — the moment the run ends, the evidence is only what you " +
  "wrote in your comment. Never describe a browser session as test coverage, " +
  "and never mark an acceptance criterion as covered by a suite because you " +
  "clicked through it once. Claiming a durable test you did not write is " +
  "worse than reporting honestly that you verified it by hand.\n" +
  "WHEN TO USE IT. When the question is whether a web page actually works, " +
  "open it and look — that beats asserting it from the diff. Navigate to the " +
  "change, snapshot the page, exercise the path a user would take, and read " +
  "`browser_console_messages` for errors the page hit on load. A rendering " +
  "failure, a hydration error, a broken handler, or a request 500ing are all " +
  "invisible in source and obvious in a browser.\n" +
  "YOU NEED SOMETHING SERVING THE PAGE. These tools navigate to a URL; they " +
  "do not build or start anything. Use a dev server the project itself " +
  "defines (check `package.json` for its script) or a deployed preview URL " +
  "given to you in the ticket. If you cannot get the app serving, say so and " +
  "verify what you can by other means — do not report a browser check you did " +
  "not run.";
