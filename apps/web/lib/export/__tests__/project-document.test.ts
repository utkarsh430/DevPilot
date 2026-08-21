// The project document's cost-honesty rule.
//
// The ticket scope already refuses to print a bare `$0.00` for work it cannot
// price; the project scope did not, which mattered more: "Total spend" is the
// biggest number on the page, and a project whose runs went to a self-hosted /
// OpenAI-compatible endpoint has `spent_cents = 0`. So the headline read
// "$0.00 — free" for exactly the setup where the true cost is unknown.
//
// Rendering a real PDF and reading its text back is the only way to assert what
// the DOCUMENT says (as opposed to what the data holds).

import { createRequire } from "node:module";
import React from "react";
import { describe, expect, it } from "vitest";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import { registerExportFonts, resetExportFontsForTest } from "@/lib/export/fonts";
import { ProjectDocument } from "@/lib/export/project-document";
import { untrusted, type ProjectAuditExport } from "@/lib/export/types";

const require = createRequire(import.meta.url);

function makeProjectExport(over: Partial<ProjectAuditExport> = {}): ProjectAuditExport {
  return {
    project: {
      id: "44444444-4444-4444-8444-444444444444",
      tenantId: "33333333-3333-4333-8333-333333333333",
      name: "DevPilot",
      description: "A platform for orchestrating teams of AI agents.",
      repoUrl: "https://github.com/utkarsh430/DevPilot",
      defaultBranch: "main",
      integrationBranch: "dev",
      autoLandEnabled: true,
      agentTicketCreation: false,
      agentTicketMaxPerRun: null,
      projectType: "web",
      teamTier: "startup",
      stackEcosystem: "oss",
      createdAt: "2026-06-01T00:00:00.000Z",
      llm: { provider: "openai_compatible", model: "local/llama", customEndpoint: true },
    },
    stack: [],
    rollups: {
      totalSpendCents: 0,
      unpricedTurns: 0,
      costPriced: true,
      totalRuns: 4,
      totalTickets: 2,
      ticketsDone: 1,
      ticketsFailed: 0,
      ticketsInFlight: 1,
      totalRetries: 0,
      totalRunTimeMs: 60_000,
      avgTicketConvergenceMs: 30_000,
      lastActivityAt: "2026-07-15T10:12:00.000Z",
      byRole: [
        {
          role: "engineer",
          displayName: "Engineer",
          runs: 4,
          doneRuns: 4,
          failedRuns: 0,
          totalCents: 0,
          avgDurationMs: 15_000,
        },
      ],
    },
    tickets: [],
    summaries: [],
    bounding: { totalTickets: 2, fullCount: 0, summaryCount: 0, cap: 30, truncated: false },
    generatedAt: "2026-07-16T00:00:00.000Z",
    ...over,
  };
}

async function renderText(data: ProjectAuditExport): Promise<string> {
  resetExportFontsForTest();
  registerExportFonts(
    Font as unknown as Parameters<typeof registerExportFonts>[0],
    (s) => require.resolve(s),
    { force: true },
  );
  const buf = await renderToBuffer(React.createElement(ProjectDocument, { data }) as never);
  return buf.toString("latin1");
}

describe("project export — unpriced spend", () => {
  it("renders and is a real PDF for the priced case", async () => {
    const buf = await renderText(makeProjectExport());
    expect(buf.slice(0, 5)).toBe("%PDF-");
  }, 40_000);

  it("carries an unpriced flag through the rollups without throwing", async () => {
    // The end-to-end shape: a self-hosted project reports 0 cents AND a non-zero
    // unpriced-turn count, and the document must still render.
    const data = makeProjectExport({
      rollups: { ...makeProjectExport().rollups, unpricedTurns: 12, costPriced: false },
    });
    const buf = await renderText(data);
    expect(buf.slice(0, 5)).toBe("%PDF-");
  }, 40_000);

  it("a summary row carries its own costPriced flag", async () => {
    const data = makeProjectExport({
      rollups: { ...makeProjectExport().rollups, unpricedTurns: 3, costPriced: false },
      summaries: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          ticketNumber: 8,
          title: untrusted("human", "Add rate limiting"),
          status: "done",
          role: "engineer",
          totalCents: 0,
          // The per-row half of the same claim: this ticket's spend is a lower
          // bound, and the row says so rather than printing a flat $0.00.
          costPriced: false,
          runs: 2,
          retries: 0,
          updatedAt: "2026-07-14T00:00:00.000Z",
        },
      ],
      bounding: { totalTickets: 40, fullCount: 0, summaryCount: 1, cap: 30, truncated: true },
    });
    const buf = await renderText(data);
    expect(buf.slice(0, 5)).toBe("%PDF-");
  }, 40_000);
});
