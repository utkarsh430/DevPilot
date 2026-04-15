// Pure policy: should this dispatch tell the runner to record verification?
//
// The bug this closes (the 20/20 fail-open)
// ─────────────────────────────────────────
// The L1 gate has TWO switches, and until now they lived in two different
// PROCESSES on two different hosts:
//
//   • `ENGINEER_QA_GATE_ENABLED` — read by the ENGINE (`isEngineerQaGateEnabled`,
//     `lib/board/qa-gate.ts`), decides whether `transitionTicket` enforces.
//   • `ENGINEER_QA_VERIFY_ENABLED` — read by the RUNNER's own `env.ts` at module
//     load (`apps/runner/src/env.ts`), decides whether anything is ever
//     RECORDED.
//
// The runner is a separate process, usually on a separate always-on host with
// its own environment (`infra/README.md`). So the two can silently disagree —
// and in prod they did: the gate was enabled, the runner was not recording, and
// `decideQaGate` fails OPEN on an absent record. Every one of the 20 QA rejects
// whose reason cites a failing build or test had NO `run_verifications` row at
// all. The gate was on, and it let all 20 through, because it had nothing to
// read. An enforcement switch whose evidence supply is configured somewhere
// else is not an enforcement switch.
//
// The fix is to stop asking the runner host what to do. The ENGINE resolves the
// recording switch at dispatch time and ships the answer on the job payload;
// the runner obeys it. The runner's own env var survives only as a fallback for
// a job that predates the field (an old engine talking to a new runner), so the
// upgrade is ordering-independent.
//
// THE INVARIANT: enabling the gate implies enabling recording. There is no
// useful configuration in which the engine refuses hand-offs on evidence it has
// forbidden anyone to collect — that configuration is exactly the silent
// fail-open above. Shadow mode (record, don't enforce) remains expressible and
// is still the default: `ENGINEER_QA_VERIFY_ENABLED` on its own records without
// enforcing. What is no longer expressible is enforce-without-recording.

/** Parse a truthy env flag. Mirrors `isEngineerQaGateEnabled`'s parser exactly —
 *  same accepted spellings, same default-off polarity. */
function isFlagOn(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Pure core: given both raw flag values, should the runner record?
 *
 * `true` when EITHER is on:
 *   • verify on, gate off  → shadow mode (record, don't enforce). Unchanged.
 *   • verify off, gate ON  → the fixed case. The gate needs evidence to be
 *     anything other than a no-op, so recording is implied.
 *   • both on              → enforce. Unchanged.
 *   • both off             → inert. Unchanged (the default).
 */
export function decideQaVerifyEnabled(input: {
  verifyFlag: string | undefined;
  gateFlag: string | undefined;
}): boolean {
  return isFlagOn(input.verifyFlag) || isFlagOn(input.gateFlag);
}

/**
 * Engine-side resolution, read once per dispatch and shipped on the job payload
 * (`lib/engine/run-agent.ts`'s `lc-enqueue`). The runner never consults its own
 * host env when this is present — see `apps/runner/src/index.ts`.
 */
export function resolveQaVerifyEnabled(): boolean {
  return decideQaVerifyEnabled({
    verifyFlag: process.env.ENGINEER_QA_VERIFY_ENABLED,
    gateFlag: process.env.ENGINEER_QA_GATE_ENABLED,
  });
}
