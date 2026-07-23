// Shared fixtures for the export unit tests.
//
// Deliberately nasty where it matters: the ticket is agent-filed (so its own
// title/description are agent-authored), one run is unpriced, the QA gate
// FAILED, a blocker is done-but-unlanded, the markdown carries raw HTML and a
// `javascript:` link, and the title carries a CRLF header-injection attempt.
// A fixture that only exercises the happy path proves nothing about the
// properties this feature exists to hold.

import {
  rollupCost,
  untrusted,
  type ExportComment,
  type ExportHandoff,
  type ProjectAuditExport,
  type RunAudit,
  type TicketAuditExport,
} from "@/lib/export/types";

export const NASTY_TITLE = 'Fix login\r\nX-Injected: yes"; filename="evil.sh';

export const NASTY_MARKDOWN = [
  "## What I did",
  "",
  "<script>alert('xss')</script>",
  "",
  "Wired the [handler](javascript:alert(1)) and the [docs](https://example.com/docs).",
  "",
  "| step | result |",
  "|------|--------|",
  "| build | ok |",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
].join("\n");

export function makeRun(overrides: Partial<RunAudit> = {}): RunAudit {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "done",
    statusReason: null,
    runnerKind: "local-cc",
    role: "engineer",
    agentName: "Ada",
    budgetCents: 500,
    spentCents: 137,
    createdAt: "2026-07-15T10:00:00.000Z",
    lastEventAt: "2026-07-15T10:12:00.000Z",
    fanOutGroup: null,
    fanOutRole: null,
    replayOfRunId: null,
    langfuseTraceUrl:
      "https://us.cloud.langfuse.com/project/p1/traces/11111111-1111-4111-8111-111111111111",
    turns: [
      {
        idx: 0,
        createdAt: "2026-07-15T10:01:00.000Z",
        text: untrusted("agent", NASTY_MARKDOWN),
        model: "claude-opus-4-8",
        runnerKind: "local-cc",
        llmProvider: "anthropic",
        finishReason: "stop",
        costCents: 100,
        costPriced: true,
        usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 },
      },
      {
        idx: 1,
        createdAt: "2026-07-15T10:06:00.000Z",
        text: untrusted("agent", "Ran the suite; one failure in `auth.test.ts`."),
        model: "local/llama",
        runnerKind: "api",
        llmProvider: "openai_compatible",
        finishReason: "stop",
        costCents: 0,
        // The unpriced case — a self-hosted endpoint we have no price table for.
        costPriced: false,
        usage: { promptTokens: 800, completionTokens: 120, totalTokens: 920 },
      },
    ],
    toolUses: [
      {
        idx: 50_001,
        createdAt: "2026-07-15T10:08:00.000Z",
        summary: untrusted("agent", "pnpm test"),
      },
    ],
    verification: {
      command: untrusted("system", "pnpm test"),
      exitCode: 1,
      headSha: "abcdef1234567890",
      baseSha: "0987654321fedcba",
      pushed: false,
      outputTail: untrusted("system", "FAIL auth.test.ts\n  ✗ rejects an expired token"),
    },
    ...overrides,
  };
}

export function makeComment(over: Partial<ExportComment> = {}): ExportComment {
  return {
    kind: "comment",
    id: "c1",
    authorType: "human",
    authorId: "operator",
    createdAt: "2026-07-15T09:00:00.000Z",
    body: untrusted("human", "Please make sure expired tokens are rejected."),
    ...over,
  };
}

export function makeHandoff(over: Partial<ExportHandoff> = {}): ExportHandoff {
  return {
    kind: "handoff",
    id: "h1",
    role: "engineer",
    handoffKind: "built",
    runId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-07-15T10:11:00.000Z",
    body: untrusted(
      "agent",
      "Added `verifyToken()` in `lib/auth/token.ts`. Exported from the index.",
    ),
    ...over,
  };
}

export function makeTicketExport(): TicketAuditExport {
  const runs = [makeRun()];
  return {
    ticket: {
      id: "22222222-2222-4222-8222-222222222222",
      tenantId: "33333333-3333-4333-8333-333333333333",
      projectId: "44444444-4444-4444-8444-444444444444",
      ticketNumber: 42,
      // Agent-filed: `sourceRunId` is set, so title/description are agent text.
      title: untrusted("agent", NASTY_TITLE),
      description: untrusted("agent", NASTY_MARKDOWN),
      acceptanceCriteria: untrusted("human", "- Expired tokens are rejected\n- Tests pass"),
      status: "in_review",
      priority: 2,
      retryCount: 1,
      safetyCritical: true,
      planHold: false,
      planSessionId: null,
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      assigneeAgentId: null,
      requestedRole: "engineer",
      gitBranchName: "devpilot/fix-login",
      landedSha: null,
      integratedAt: null,
      parentTicketId: null,
      createdAt: "2026-07-15T08:00:00.000Z",
      updatedAt: "2026-07-15T10:12:00.000Z",
      labels: [{ name: "auth", color: "#ff0000" }],
    },
    thread: [makeComment(), makeHandoff()],
    relations: {
      blockedBy: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          ticketNumber: 7,
          title: untrusted("human", "Introduce the token store"),
          status: "done",
          // The WI-5 case: done, but its commits are not on dev yet.
          landOpenness: "awaiting_land",
        },
      ],
      blocks: [],
      buildsOn: [],
      builtOnBy: [],
      related: [],
      duplicate: [],
      subIssues: [],
    },
    attachments: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        mime: "image/png",
        bytes: 1024,
        dataUri: null,
        unavailableReason: "storage fetch timed out",
      },
    ],
    runs,
    cost: rollupCost(runs),
  };
}

// ─── A project at REAL richness ─────────────────────────────────────────────
//
// The per-ticket fixture above is nasty about CONTENT (injection attempts,
// unpriced turns, a failed QA gate). It is tiny about STRUCTURE — one run, a
// two-entry thread, a description that fits on one page. Structure is what the
// project document is made of, and a fixture that never fills a page cannot
// exercise pagination, the fixed running chrome across pages, or an outline
// with more than a couple of entries. That gap is why a 9-ticket export could
// die in prod with every test green.
//
// `makeRichProjectExport` is deliberately shaped like the real thing that
// broke: 9 fully-detailed tickets, each with a long description, a full thread
// and several runs, plus the stack table and the truncated-summary table. It
// renders to ~100 pages.

/** Matches the real project that surfaced the crash — enough to paginate hard. */
export const RICH_TICKET_COUNT = 9;

/** Long enough that one ticket alone spans several pages. */
function longMarkdown(seed: number): string {
  return Array.from(
    { length: 30 },
    (_, k) =>
      `Paragraph ${k} of ticket ${seed} — ${"the agent explored the module and wrote it up at length. ".repeat(6)}`,
  ).join("\n\n");
}

function makeRichTicket(i: number): TicketAuditExport {
  const base = makeTicketExport();
  const body = longMarkdown(i);
  const runs = Array.from({ length: 3 }, (_, k) =>
    makeRun({ id: `1111${i}${k}11-1111-4111-8111-111111111111` }),
  );
  return {
    ...base,
    ticket: {
      ...base.ticket,
      id: `2222${i}222-2222-4222-8222-222222222222`,
      ticketNumber: i + 1,
      description: untrusted("agent", body),
    },
    thread: Array.from({ length: 10 }, (_, k) =>
      k % 2 === 0
        ? makeComment({ id: `c${i}-${k}`, body: untrusted("human", body.slice(0, 700)) })
        : makeHandoff({ id: `h${i}-${k}`, body: untrusted("agent", body.slice(0, 700)) }),
    ),
    runs,
    cost: rollupCost(runs),
  };
}

/**
 * A single ticket long enough to span many pages, with runs that SPLIT across
 * page boundaries.
 *
 * This is the fixture for the split-run-card regression (`split-run-card.test.ts`).
 * The out-of-range-coordinate crash only surfaced once a single ticket's content
 * wrapped across enough pages for the `bottom`-anchored running footer to diverge
 * (see `Chrome.Footer`), so the fixture must paginate HARD — many runs, each with
 * several turns of long narration — not merely split one card. That depth is what
 * used to make the footer emit `-2.996737976248788e+21`.
 */
export function makeSplittingRunTicket(): TicketAuditExport {
  const base = makeTicketExport();
  const narration = (seed: number) =>
    Array.from(
      { length: 22 },
      (_, k) =>
        `Paragraph ${k} of run ${seed} — ${"the agent read the module, reasoned about the change, and wrote it up in detail. ".repeat(5)}`,
    ).join("\n\n");
  // Many runs, each tall enough that the card cannot fit in the remaining space
  // on the page it starts on — so at least one card is forced to split.
  const runs = Array.from({ length: 8 }, (_, k) =>
    makeRun({
      id: `7777${k}777-7777-4777-8777-777777777777`,
      turns: [
        {
          idx: 0,
          createdAt: "2026-07-15T10:01:00.000Z",
          text: untrusted("agent", narration(k)),
          model: "claude-opus-4-8",
          runnerKind: "local-cc",
          llmProvider: "anthropic",
          finishReason: "stop",
          costCents: 100,
          costPriced: true,
          usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 },
        },
        {
          idx: 1,
          createdAt: "2026-07-15T10:06:00.000Z",
          text: untrusted("agent", narration(k + 100)),
          model: "claude-opus-4-8",
          runnerKind: "local-cc",
          llmProvider: "anthropic",
          finishReason: "stop",
          costCents: 80,
          costPriced: true,
          usage: { promptTokens: 900, completionTokens: 250, totalTokens: 1150 },
        },
      ],
    }),
  );
  return { ...base, runs, cost: rollupCost(runs) };
}

/**
 * `truncated` is a real axis, not a flag for completeness' sake.
 *
 * It adds the conditional "Ticket summary" PAGE, which shifts react-pdf's
 * breadth-first bookmark numbering by one — and that shift is exactly what
 * decided whether the old positional `parent: 4` happened to land on the
 * Ticket-detail page or on the Configuration section. A fixture pinned to
 * either value tests only half of it, and the truncated half was the half that
 * WORKED. Default to `false`: that is the common case (a project under the
 * 30-ticket cap) and the one that was broken.
 */
export function makeRichProjectExport({ truncated = false } = {}): ProjectAuditExport {
  const tickets = Array.from({ length: RICH_TICKET_COUNT }, (_, i) => makeRichTicket(i));
  const summaries = truncated
    ? Array.from({ length: 40 }, (_, k) => ({
        id: `9999${k}999-9999-4999-8999-999999999999`,
        ticketNumber: 100 + k,
        title: untrusted("human", `Summary row ${k} with a title long enough to wrap in its cell`),
        status: "done" as const,
        role: "engineer",
        totalCents: 12 * k,
        costPriced: k % 4 !== 0,
        runs: 2,
        retries: k % 3,
        updatedAt: "2026-07-14T00:00:00.000Z",
      }))
    : [];
  return {
    project: {
      id: "44444444-4444-4444-8444-444444444444",
      tenantId: "33333333-3333-4333-8333-333333333333",
      name: "Todo App",
      description: "A task manager built by a crew of agents.",
      repoUrl: "https://github.com/utkarsh430/todo-app",
      defaultBranch: "main",
      integrationBranch: "dev",
      autoLandEnabled: true,
      agentTicketCreation: false,
      agentTicketMaxPerRun: null,
      projectType: "web",
      teamTier: "startup",
      stackEcosystem: "oss",
      createdAt: "2026-06-01T00:00:00.000Z",
      llm: { provider: "anthropic", model: "claude-opus-4-8", customEndpoint: false },
    },
    // A populated capability table — the minimal fixture passed `[]`, so the
    // whole component was unrendered by every test.
    stack: Array.from({ length: 10 }, (_, k) => ({
      capability: `capability_${k}`,
      service: `service-${k}`,
      provider: k % 2 === 0 ? "oss" : "aws",
      freeTier: "limited_free",
      freeTierNote: "Free up to 500 MB of storage and 2 GB of egress per month.",
      overridden: k % 3 === 0,
    })),
    rollups: {
      totalSpendCents: 430,
      unpricedTurns: 4,
      // The honest case for a project with an unpriced turn: a spend figure AND
      // the caveat that says it is a lower bound.
      costPriced: false,
      totalRuns: RICH_TICKET_COUNT * 3,
      totalTickets: RICH_TICKET_COUNT + summaries.length,
      ticketsDone: 5,
      ticketsFailed: 1,
      ticketsInFlight: 3,
      totalRetries: 2,
      totalRunTimeMs: 3_600_000,
      avgTicketConvergenceMs: 400_000,
      lastActivityAt: "2026-07-15T10:12:00.000Z",
      byRole: [
        {
          role: "engineer",
          displayName: "Engineer",
          runs: 12,
          doneRuns: 10,
          failedRuns: 2,
          totalCents: 300,
          avgDurationMs: 15_000,
        },
        {
          role: "qa",
          displayName: "QA",
          runs: 8,
          doneRuns: 8,
          failedRuns: 0,
          totalCents: 90,
          avgDurationMs: 9_000,
        },
        {
          role: "product_manager",
          displayName: "PM",
          runs: 4,
          doneRuns: 4,
          failedRuns: 0,
          totalCents: 40,
          avgDurationMs: 6_000,
        },
        // A zero-spend role: exercises the Bar's `max`/`value` edge.
        {
          role: "security",
          displayName: "Security",
          runs: 3,
          doneRuns: 3,
          failedRuns: 0,
          totalCents: 0,
          avgDurationMs: 4_000,
        },
      ],
    },
    tickets,
    // Beyond the detail cap — when present this renders the summary table,
    // whose header row is `fixed` and so repeats across every page it spans.
    summaries,
    bounding: {
      totalTickets: RICH_TICKET_COUNT + summaries.length,
      fullCount: RICH_TICKET_COUNT,
      summaryCount: summaries.length,
      cap: 30,
      truncated,
    },
    generatedAt: "2026-07-16T00:00:00.000Z",
  };
}
