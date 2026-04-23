// The 2026-08-06 incident: `invokeLocalCcOneShot` inserted a `runs` row with a
// real `ticket_id` for audit-trail joins, but hardcoded the enqueued job's
// `ticketId` to `null` regardless — so a direct `runs` query and the job the
// runner actually popped off `devpilot:jobs:local-cc:ready` disagreed about
// which ticket the run belonged to. The runner logged
// `ticketId=<none>` for a run whose `runs.ticket_id` was set, which on the
// callers that fire on every dispatch boundary (the F2 role classifier —
// `classifyNextRole`/`classifyTicketRoleIfNeeded` — and the mistake-harvest
// lesson extractor) inflated the "runs per ticket" count relative to
// "workspaces prepared per ticket" measured on the olympussai board.
//
// `local-cc-oneshot.server.ts` is `server-only` (touches Supabase + Redis) and
// cannot be imported under Vitest, so the shape it builds is asserted here via
// the pure, DI-free `buildOneShotJobPayload`, plus a source scan proving the
// server-only file actually calls it rather than reintroducing an inline
// hardcoded `ticketId: null`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOneShotJobPayload } from "@/lib/runners/local-cc-oneshot-job";

describe("buildOneShotJobPayload - ticketId must match the run row, always", () => {
  it("threads a real ticketId into the job payload (THE INCIDENT'S FIX)", () => {
    const payload = buildOneShotJobPayload(
      { tenantId: "t-1", prompt: "p", systemPrompt: "s", ticketId: "ticket-abc" },
      { jobId: "job-1", runId: "run-1", engineUrl: "https://engine.example" },
    );
    expect(payload.ticketId).toBe("ticket-abc");
  });

  it("stays null for a genuinely ticket-less caller (the 48-legitimate-case control)", () => {
    const payload = buildOneShotJobPayload(
      { tenantId: "t-1", prompt: "p", systemPrompt: "s" },
      { jobId: "job-1", runId: "run-1", engineUrl: "https://engine.example" },
    );
    expect(payload.ticketId).toBeNull();
  });

  it("null ticketId argument is preserved as null, not coerced away", () => {
    const payload = buildOneShotJobPayload(
      { tenantId: "t-1", prompt: "p", systemPrompt: "s", ticketId: null },
      { jobId: "job-1", runId: "run-1", engineUrl: "https://engine.example" },
    );
    expect(payload.ticketId).toBeNull();
  });
});

describe("buildOneShotJobPayload - workspace prep is ALWAYS suppressed for this bridge", () => {
  it("stamps workspacePrepEligible: false even when a real ticketId is present", () => {
    // This is what keeps the fix above safe: a real ticketId alone must never
    // make the runner attempt `prepareWorkspace()` for a one-shot text call —
    // that would race a concurrent producer's live workspace for the same
    // ticket (see apps/runner/src/workspace-precondition.ts).
    const payload = buildOneShotJobPayload(
      { tenantId: "t-1", prompt: "p", systemPrompt: "s", ticketId: "ticket-abc" },
      { jobId: "job-1", runId: "run-1", engineUrl: "https://engine.example" },
    );
    expect(payload.workspacePrepEligible).toBe(false);
  });

  it("stamps workspacePrepEligible: false for the ticket-less case too", () => {
    const payload = buildOneShotJobPayload(
      { tenantId: "t-1", prompt: "p", systemPrompt: "s" },
      { jobId: "job-1", runId: "run-1", engineUrl: "https://engine.example" },
    );
    expect(payload.workspacePrepEligible).toBe(false);
  });
});

describe("buildOneShotJobPayload - the rest of the shape", () => {
  it("carries the ids and prompts through untouched", () => {
    const payload = buildOneShotJobPayload(
      { tenantId: "tenant-9", prompt: "the prompt", systemPrompt: "the system prompt" },
      { jobId: "job-9", runId: "run-9", engineUrl: "https://engine.example" },
    );
    expect(payload).toMatchObject({
      jobId: "job-9",
      runId: "run-9",
      tenantId: "tenant-9",
      iterationIdx: 0,
      prompt: "the prompt",
      systemPrompt: "the system prompt",
      engineUrl: "https://engine.example",
    });
  });

  it("omits modelTier when absent, includes it when supplied (matches the pre-fix behaviour)", () => {
    const withoutTier = buildOneShotJobPayload(
      { tenantId: "t-1", prompt: "p", systemPrompt: "s" },
      { jobId: "job-1", runId: "run-1", engineUrl: "https://engine.example" },
    );
    expect("modelTier" in withoutTier).toBe(false);

    const withTier = buildOneShotJobPayload(
      { tenantId: "t-1", prompt: "p", systemPrompt: "s", modelTier: "cheap" },
      { jobId: "job-1", runId: "run-1", engineUrl: "https://engine.example" },
    );
    expect(withTier.modelTier).toBe("cheap");
  });
});

describe("local-cc-oneshot.server.ts wiring - the run row and the job must agree", () => {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const source = readFileSync(
    path.join(webRoot, "lib", "runners", "local-cc-oneshot.server.ts"),
    "utf8",
  );

  it("inserts the runs row with the caller's real ticketId", () => {
    expect(source).toMatch(/ticket_id: args\.ticketId \?\? null/);
  });

  it("builds the enqueued job through buildOneShotJobPayload, not an inline literal", () => {
    // The regression this guards against: someone re-inlining
    // `ticketId: null` (or any other hardcoded value) directly into the
    // JSON.stringify call, silently reopening the divergence between the
    // `runs` row above and the job the runner pops.
    expect(source).toMatch(/buildOneShotJobPayload\(/);
    expect(source).not.toMatch(/ticketId:\s*null,/);
  });

  it("passes the caller's ticketId through to the payload builder", () => {
    const callAt = source.indexOf("buildOneShotJobPayload(");
    expect(callAt).toBeGreaterThan(0);
    const call = source.slice(callAt, source.indexOf(");", callAt) + 2);
    expect(call).toMatch(/ticketId:\s*args\.ticketId/);
  });
});
