// The run-scoped outcome marker — how the RUNNER learns what the MCP RELAY did.
//
// WHY A FILE, AND NOT SOMETHING SMARTER
// ─────────────────────────────────────
// The verdictless seam (`verdict-outcome.ts`) has to answer one question after
// `claude -p` returns: did this run record an outcome for its ticket? The answer
// is produced in a DIFFERENT OS PROCESS — `mcp/server.ts` is a stdio subprocess
// of `claude`, spawned per step — so the runner cannot see it in memory. Three
// candidates, and the other two are worse:
//
//   • ASK THE ENGINE. A new authenticated endpoint, a network round trip on the
//     step-completion path, and a second definition of "recorded an outcome"
//     living somewhere other than the act that records it. It also fails exactly
//     when the engine is unwell, which is when runs strand most.
//   • PARSE THE `claude -p` STREAM for tool_use events. Two spawn paths (direct
//     and tmux-over-FIFO) both consume that stream today and neither surfaces
//     tool calls; adding a parser makes the answer depend on an output format we
//     do not own, and a format change would silently return "no verdict" — the
//     failure direction that spends a turn on every healthy review.
//   • THIS: the process that performs the relay writes down that it performed
//     it. One writer, one reader, no network, no parsing, and the marker is the
//     same act the reconciler's own evidence comes from (a successful
//     `devpilot_move_ticket` relay is what stamps the system comment
//     `moveTicketToolUsed` looks for), one hop apart.
//
// THE PATH IS CHOSEN BY THE RUNNER AND INJECTED, never derived on the relay
// side. The relay is handed `DEVPILOT_OUTCOME_MARKER_PATH` in the same
// `envOverrides` map that already carries `DEVPILOT_RUN_ID` / `DEVPILOT_ROLE` /
// `DEVPILOT_WORKSPACE_PATH`, so it reaches both spawn paths by construction and
// there is exactly one place that decides where these files live.
//
// SCOPE IS PER RUN, NOT PER STEP. A verdict recorded on turn 1 of a multi-turn
// run is still recorded on turn 3, and a per-step marker would forget it and
// nudge a reviewer that had already decided.
//
// EVERY FUNCTION HERE IS TOTAL. The writer must never break a tool call that
// otherwise succeeded, and the reader must never break a run: a read failure is
// reported as `null` (indeterminate) and the caller fails OPEN on it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where run markers live. One directory so the boot sweep has one target. */
export function outcomeMarkerRootDir(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, "devpilot-run-outcomes");
}

/**
 * The marker path for a run. `path.basename` on the run id is the same
 * defensive normalisation `writeStepMcpConfig` applies: the id comes from a
 * queue payload, and a value containing separators must not be able to steer a
 * write outside this directory.
 */
export function outcomeMarkerPathFor(runId: string, tmpDir: string = os.tmpdir()): string {
  return path.join(outcomeMarkerRootDir(tmpDir), `${path.basename(runId)}.log`);
}

/**
 * Record that an outcome-recording tool relayed SUCCESSFULLY for this run.
 *
 * Append-only, one tool name per line: two calls in one run are two lines, and
 * the reader only ever asks whether the list is empty. Appending rather than
 * truncating means a later call can never erase an earlier one — which matters,
 * because "the reviewer moved the ticket and THEN asked a question" must still
 * read as an outcome.
 *
 * Called ONLY on `ok` responses. A refused relay (a 422 from the QA gate, say)
 * records nothing, which is right: the ticket did not move, the reviewer still
 * owes a verdict, and the nudge should fire.
 *
 * Never throws. An unwritable marker degrades to a nudge that may fire
 * needlessly — one wasted turn — which is the correct direction to fail when the
 * alternative is breaking a tool call that worked.
 */
export function markOutcomeRecorded(markerPath: string | undefined | null, tool: string): boolean {
  if (!markerPath) return false;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.appendFileSync(markerPath, `${tool}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read back the outcome-recording tools this run relayed successfully.
 *
 * Returns:
 *   • `[]`   — the file does not exist. The DEFINITE negative: the relay creates
 *              it on its first success, so its absence is "nothing was recorded".
 *   • `[…]`  — one entry per successful relay.
 *   • `null` — the file exists but could not be read (permissions, a truncated
 *              read, anything unexpected). INDETERMINATE, and the caller must
 *              fail open on it rather than treat it as empty.
 *
 * The ENOENT-is-empty reading has one imperfect case, stated rather than hidden:
 * if the relay's own append failed, this reads as "nothing recorded" and a nudge
 * fires needlessly. That costs one turn and the relay logs its failure; the
 * alternative — treating a missing file as indeterminate — would disable the
 * seam entirely for every healthy run, since a run with no verdict legitimately
 * has no file.
 */
export function readRecordedOutcomes(markerPath: string | null | undefined): string[] | null {
  if (!markerPath) return null;
  try {
    const raw = fs.readFileSync(markerPath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    return null;
  }
}

/** Drop a run's marker once its step is done. Best-effort; a leftover file is
 *  swept at the next runner boot. */
export function removeOutcomeMarker(markerPath: string | null | undefined): void {
  if (!markerPath) return;
  try {
    fs.rmSync(markerPath, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Wipe the whole marker root at runner boot.
 *
 * Same posture and the same reasoning as `sweepStaleAttachments`: a marker is
 * only meaningful for a run this process is currently executing, so anything
 * present at startup belongs to a previous process and can only mislead. Wiping
 * wholesale is safe because the worst case is a nudge that fires when it need
 * not have — never a verdict that gets skipped.
 */
export function sweepStaleOutcomeMarkers(tmpDir: string = os.tmpdir()): void {
  try {
    fs.rmSync(outcomeMarkerRootDir(tmpDir), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
