import { describe, expect, it } from "vitest";
import {
  correlateToRun,
  deriveMistakes,
  SCORE_COUNTING_TYPES,
  type HarvestInput,
  type HarvestRun,
  type HarvestVerification,
} from "@/lib/learning/harvest";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TICKET = "11111111-1111-4111-8111-111111111111";

const run = (over: Partial<HarvestRun> & { runId: string; createdAt: string }): HarvestRun => ({
  agentId: "agent-eng",
  role: "engineer",
  onSuccessStatus: "in_review",
  status: "done",
  lastEventAt: over.lastEventAt ?? over.createdAt,
  ...over,
});

const base = (over: Partial<HarvestInput> = {}): HarvestInput => ({
  ticket: { ticketId: TICKET, tenantId: T, retryCount: 0, status: "done" },
  runs: [],
  verifications: [],
  comments: [],
  ...over,
});

describe("deriveMistakes — run_failed", () => {
  it("one row per failed run, counts against score, attributed to that run", () => {
    const out = deriveMistakes(
      base({
        runs: [
          run({
            runId: "r1",
            createdAt: "2026-07-15T08:00:00Z",
            status: "failed",
            failureText: "boom",
          }),
          run({ runId: "r2", createdAt: "2026-07-15T09:00:00Z", status: "done" }),
        ],
      }),
    );
    const failed = out.filter((m) => m.type === "run_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      dedupeKey: "run_failed:r1",
      runId: "r1",
      role: "engineer",
      countsAgainstScore: true,
      severity: 3,
    });
    expect(failed[0]!.evidence).toMatchObject({ status: "failed", finalText: "boom" });
    // corrected_by points at the next run.
    expect(failed[0]!.correctedBy).toMatchObject({ nextRunId: "r2" });
  });
});

describe("deriveMistakes — verification_fail", () => {
  const verification = (
    over: Partial<HarvestVerification> & { runId: string },
  ): HarvestVerification => ({
    command: "pnpm test",
    exitCode: 1,
    outputTail: "3 failing",
    ranAt: "2026-07-15T08:30:00Z",
    ...over,
  });

  it("harvests exit_code>0, ignores 0 and <0", () => {
    const out = deriveMistakes(
      base({
        runs: [run({ runId: "r1", createdAt: "2026-07-15T08:00:00Z" })],
        verifications: [
          verification({ runId: "r1", exitCode: 1 }),
          verification({ runId: "rP", exitCode: 0 }),
          verification({ runId: "rI", exitCode: -1 }),
        ],
      }),
    );
    const vf = out.filter((m) => m.type === "verification_fail");
    expect(vf.map((m) => m.dedupeKey)).toEqual(["verification_fail:r1"]);
    expect(vf[0]).toMatchObject({ runId: "r1", role: "engineer", countsAgainstScore: true });
    expect(vf[0]!.evidence).toMatchObject({
      command: "pnpm test",
      exitCode: 1,
      outputTail: "3 failing",
    });
  });

  it("redacts secrets/home paths in command + output_tail", () => {
    const out = deriveMistakes(
      base({
        runs: [run({ runId: "r1", createdAt: "2026-07-15T08:00:00Z" })],
        verifications: [
          verification({
            runId: "r1",
            command: "TOKEN=ghp_abcdefghij0123456789ABCDEFGHIJ pnpm test",
            outputTail: "EACCES /Users/utkarsh430/x",
          }),
        ],
      }),
    );
    const ev = out.find((m) => m.type === "verification_fail")!.evidence as Record<string, string>;
    expect(ev.command).not.toContain("ghp_abcdefghij0123456789ABCDEFGHIJ");
    expect(ev.outputTail).toBe("EACCES /Users/<redacted>/x");
  });

  it("corrected_by records the clean re-verification", () => {
    const out = deriveMistakes(
      base({
        runs: [
          run({ runId: "r1", createdAt: "2026-07-15T08:00:00Z" }),
          run({ runId: "r2", createdAt: "2026-07-15T09:00:00Z" }),
        ],
        verifications: [
          verification({ runId: "r1", exitCode: 1, ranAt: "2026-07-15T08:30:00Z" }),
          verification({ runId: "r2", exitCode: 0, ranAt: "2026-07-15T09:30:00Z" }),
        ],
      }),
    );
    const vf = out.find((m) => m.type === "verification_fail")!;
    expect(vf.correctedBy).toMatchObject({ nextRunId: "r2", reVerificationClean: true });
  });
});

describe("deriveMistakes — gate_refusal", () => {
  it("harvests each gate/ceiling comment, attributed to the producing run", () => {
    const out = deriveMistakes(
      base({
        runs: [
          run({
            runId: "r1",
            createdAt: "2026-07-15T08:00:00Z",
            lastEventAt: "2026-07-15T08:59:00Z",
          }),
        ],
        comments: [
          {
            id: "c1",
            authorType: "system",
            authorId: "devpilot_qa_gate",
            body: "tests failing",
            createdAt: "2026-07-15T08:30:00Z",
          },
          {
            id: "c2",
            authorType: "system",
            authorId: "devpilot_safety_gate",
            body: "needs approval",
            createdAt: "2026-07-15T08:40:00Z",
          },
          {
            id: "c3",
            authorType: "system",
            authorId: "devpilot_move_ticket",
            body: "not a gate",
            createdAt: "2026-07-15T08:45:00Z",
          },
        ],
      }),
    );
    const gates = out.filter((m) => m.type === "gate_refusal");
    expect(gates.map((m) => m.dedupeKey).sort()).toEqual(["gate_refusal:c1", "gate_refusal:c2"]);
    expect(gates.every((m) => m.countsAgainstScore && m.runId === "r1")).toBe(true);
    // safety gate is more severe.
    expect(gates.find((m) => m.dedupeKey === "gate_refusal:c2")!.severity).toBe(3);
  });
});

describe("deriveMistakes — qa_reject", () => {
  it("attributes rejects to producer runs, capped at retry_count, counts against score", () => {
    const out = deriveMistakes(
      base({
        ticket: { ticketId: TICKET, tenantId: T, retryCount: 1, status: "done" },
        runs: [
          // producer, superseded → rejected
          run({
            runId: "eng1",
            createdAt: "2026-07-15T08:00:00Z",
            role: "engineer",
            onSuccessStatus: "in_review",
            lastEventAt: "2026-07-15T08:30:00Z",
          }),
          // reviewer
          run({
            runId: "qa1",
            createdAt: "2026-07-15T08:40:00Z",
            role: "qa",
            onSuccessStatus: "done",
            agentId: "agent-qa",
          }),
          // producer retry (accepted, not superseded)
          run({
            runId: "eng2",
            createdAt: "2026-07-15T09:00:00Z",
            role: "engineer",
            onSuccessStatus: "in_review",
          }),
        ],
        comments: [
          {
            id: "rc",
            authorType: "system",
            authorId: "devpilot_move_ticket",
            body: "changes requested: fix nulls",
            createdAt: "2026-07-15T08:45:00Z",
          },
        ],
      }),
    );
    const rejects = out.filter((m) => m.type === "qa_reject");
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({
      dedupeKey: "qa_reject:eng1",
      runId: "eng1",
      role: "engineer",
      countsAgainstScore: true,
    });
    expect(rejects[0]!.evidence).toMatchObject({
      retryCount: 1,
      reason: "changes requested: fix nulls",
    });
  });

  it("no rejects when retry_count is 0", () => {
    const out = deriveMistakes(
      base({
        runs: [
          run({ runId: "eng1", createdAt: "2026-07-15T08:00:00Z" }),
          run({ runId: "eng2", createdAt: "2026-07-15T09:00:00Z" }),
        ],
      }),
    );
    expect(out.filter((m) => m.type === "qa_reject")).toHaveLength(0);
  });
});

describe("deriveMistakes — human_correction", () => {
  it("harvests a human reply that resumed work, and NEVER counts against score", () => {
    const out = deriveMistakes(
      base({
        ticket: { ticketId: TICKET, tenantId: T, retryCount: 0, status: "in_progress" },
        runs: [
          run({
            runId: "r1",
            createdAt: "2026-07-15T08:00:00Z",
            lastEventAt: "2026-07-15T08:20:00Z",
          }),
          run({ runId: "r2", createdAt: "2026-07-15T09:00:00Z" }),
        ],
        comments: [
          {
            id: "h1",
            authorType: "human",
            authorId: "captain@x.com",
            body: "use Vercel, not Netlify",
            createdAt: "2026-07-15T08:30:00Z",
          },
        ],
      }),
    );
    const hc = out.filter((m) => m.type === "human_correction");
    expect(hc).toHaveLength(1);
    expect(hc[0]).toMatchObject({
      dedupeKey: "human_correction:h1",
      countsAgainstScore: false,
      severity: 1,
    });
    expect(hc[0]!.evidence).toMatchObject({ comment: "use Vercel, not Netlify" });
    expect(SCORE_COUNTING_TYPES.has("human_correction")).toBe(false);
  });

  it("ignores a human comment with no following run (not a correction that resumed)", () => {
    const out = deriveMistakes(
      base({
        runs: [
          run({
            runId: "r1",
            createdAt: "2026-07-15T08:00:00Z",
            lastEventAt: "2026-07-15T08:20:00Z",
          }),
        ],
        comments: [
          {
            id: "h1",
            authorType: "human",
            authorId: "captain@x.com",
            body: "nice work",
            createdAt: "2026-07-15T09:00:00Z",
          },
        ],
      }),
    );
    expect(out.filter((m) => m.type === "human_correction")).toHaveLength(0);
  });
});

describe("determinism / dedupe", () => {
  it("is deterministic: same input → identical dedupeKeys, order-independent per source", () => {
    const input = base({
      ticket: { ticketId: TICKET, tenantId: T, retryCount: 1, status: "done" },
      runs: [
        run({
          runId: "eng1",
          createdAt: "2026-07-15T08:00:00Z",
          status: "failed",
          lastEventAt: "2026-07-15T08:30:00Z",
        }),
        run({ runId: "eng2", createdAt: "2026-07-15T09:00:00Z" }),
      ],
      verifications: [
        {
          runId: "eng1",
          command: "pnpm test",
          exitCode: 1,
          outputTail: "x",
          ranAt: "2026-07-15T08:25:00Z",
        },
      ],
    });
    const a = deriveMistakes(input)
      .map((m) => m.dedupeKey)
      .sort();
    const b = deriveMistakes(input)
      .map((m) => m.dedupeKey)
      .sort();
    expect(a).toEqual(b);
    // dedupeKeys are unique within a harvest → the unique index never rejects
    // two rows from one pass.
    expect(new Set(a).size).toBe(a.length);
  });

  it("only the four objective types count against score", () => {
    expect([...SCORE_COUNTING_TYPES].sort()).toEqual([
      "gate_refusal",
      "qa_reject",
      "run_failed",
      "verification_fail",
    ]);
  });
});

describe("correlateToRun", () => {
  const runs: HarvestRun[] = [
    run({ runId: "r1", createdAt: "2026-07-15T08:00:00Z", lastEventAt: "2026-07-15T08:30:00Z" }),
    run({ runId: "r2", createdAt: "2026-07-15T09:00:00Z", lastEventAt: "2026-07-15T09:30:00Z" }),
  ];
  it("prefers the run whose window contains the timestamp", () => {
    expect(correlateToRun("2026-07-15T08:15:00Z", runs)?.runId).toBe("r1");
    expect(correlateToRun("2026-07-15T09:15:00Z", runs)?.runId).toBe("r2");
  });
  it("falls back to the most recent run started before the timestamp", () => {
    expect(correlateToRun("2026-07-15T08:45:00Z", runs)?.runId).toBe("r1");
  });
  it("returns null when nothing had started", () => {
    expect(correlateToRun("2026-07-15T07:00:00Z", runs)).toBeNull();
  });
});
