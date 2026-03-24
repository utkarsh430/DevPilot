// Browser artifacts — carrying an agent's screenshots OUT of a run.
//
// `@playwright/mcp` is wired into every `claude -p` step with 24 browser tools,
// `browser_take_screenshot` among them. Its `--output-dir` used to point at ONE
// fixed path under the OS temp dir that nothing read, nothing uploaded, and
// nothing cleaned up: the agent saw the page, the operator got a sentence about
// the page. This module collects those files after the step and hands them to
// the engine so they land beside the step that produced them.
//
// ── Why the step association is PROVABLE, not inferred ──
// Evidence filed under the wrong step is worse than no evidence: an operator
// reads a screenshot under step 4, believes it shows step 4, and concludes with
// confidence something false. So attribution here is structural, not a timestamp
// heuristic. claude.ts writes a PER-STEP MCP config whose `--output-dir` is
// `<root>/<runId>/<stepIdx>`, and the @playwright/mcp server is a stdio CHILD of
// exactly one `claude -p` process — the one invocation the engine records as
// `run_steps (run_id, idx = iterationIdx, kind='think')`. A file in that
// directory can therefore only have been written during that step.
//
// What this does NOT establish is which TOOL CALL inside the step wrote it. The
// UI says "captured during this step" and carries each file's mtime so images
// can be ordered; it never implies per-action precision it does not have.
//
// ── Best-effort, always ──
// Every function here is total: a failed read, a failed upload, a missing
// directory all degrade to "fewer images" and never throw at the caller. The
// caller runs this AFTER the step result has already been posted, so evidence
// handling cannot affect a run's outcome even in principle.

import { readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Caps. Mirrors apps/web/lib/runs/artifacts.ts — the two apps share no package
// (same constraint as workspace-root.ts / ticket-branch.ts), so these are a
// deliberate duplicate. The engine's are authoritative: it re-checks every one
// of these AND enforces the per-run cap the runner cannot see across restarts.
// Keeping a copy here means an over-cap image costs no upload bandwidth.
export const RUNNER_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024; // 5 MiB per file
export const RUNNER_MAX_ARTIFACTS_PER_STEP = 4;

/**
 * Extensions @playwright/mcp writes for images. Anything else in the output dir
 * is not visual evidence and is skipped rather than uploaded.
 *
 * This filter is LOAD-BEARING, not defensive: @playwright/mcp writes a `.yml`
 * page snapshot alongside every screenshot, so "upload the directory" would ship
 * a YAML file to an image bucket on every single capture.
 *
 * Verified against the pinned @playwright/mcp 0.0.78 by driving the real binary
 * (`pnpm --filter @devpilot/runner accept:browser-artifacts`): captures land FLAT
 * in `--output-dir` as `page-<ISO>.png`, beside exactly such a `.yml`. Re-run
 * that script when bumping the pin — if the layout changes, collection silently
 * returns nothing and no run fails to tell you.
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

/** Root for all per-step artifact directories. Under the OS temp dir — NEVER
 *  under WORKSPACE_ROOT — so a capture can never land in a git clone (never
 *  committed, never tripping the workspace reap / foreign-host guards), exactly
 *  as the inbound attachment temp dir does. */
export function browserArtifactsRootDir(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, "devpilot-browser-artifacts");
}

/**
 * The output directory for ONE agent step. `runId` is a server-issued uuid and
 * `stepIdx` a non-negative integer, so both are safe path segments; we still
 * take `basename` of the id defensively.
 *
 * This path IS the attribution mechanism — see the header. Do not collapse it
 * back to a shared directory: concurrent steps (LOCAL_CC_CONCURRENCY > 1) would
 * then interleave their captures and nothing could tell them apart afterwards.
 */
export function browserArtifactDirForStep(
  runId: string,
  stepIdx: number,
  tmpDir: string = os.tmpdir(),
): string {
  return path.join(browserArtifactsRootDir(tmpDir), path.basename(runId), String(stepIdx));
}

/** A file found in a step's output dir. `capturedAt` is its mtime: when the
 *  browser wrote it, not when we noticed it. */
export type CapturedFile = { name: string; bytes: number; capturedAtMs: number };

/** One image selected for upload, with the provenance fields the engine stores. */
export type SelectedArtifact = {
  name: string;
  bytes: number;
  capturedAt: string;
  /** 0-based position among the step's captured images, in capture order. Kept
   *  through the cap, so a gap in the sequence is visible to the operator. */
  sequence: number;
};

export type ArtifactSelection = {
  kept: SelectedArtifact[];
  /** How many images the step captured in total, INCLUDING those the cap
   *  dropped. This is what makes the cap legible instead of silent. */
  capturedTotal: number;
  /** Human-readable reasons for anything not uploaded — logged, never fatal. */
  skipped: string[];
};

/**
 * Pure selector: decide which of a step's captured files to upload.
 *
 * The rule, and why: a step is capped at `RUNNER_MAX_ARTIFACTS_PER_STEP` images
 * and we keep the NEWEST ones. A browser flow's final frames are the assertion
 * or the failure — the state the agent was reporting on — while the earlier ones
 * are usually navigation on the way there. The rule is not hidden behind the
 * cap: `capturedTotal` is carried on every kept image so the inspector states
 * exactly how many were dropped and which end they came from.
 *
 * `sequence` is assigned BEFORE the cap, over the full capture-ordered list, so
 * a kept set of {5,6,7,8} out of 9 reads as a tail rather than as the whole
 * story renumbered from zero.
 *
 * Ordering is by mtime, tie-broken by name, so the result is deterministic even
 * when a fast flow writes two files inside one filesystem timestamp tick.
 */
export function selectArtifactsToUpload(files: readonly CapturedFile[]): ArtifactSelection {
  const skipped: string[] = [];
  const usable: CapturedFile[] = [];

  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      // Not evidence — @playwright/mcp also drops page snapshots here.
      continue;
    }
    // A filename must be a plain basename. Nothing composes these paths from
    // untrusted input today, but a name with a separator would escape the step
    // dir on read, and the whole attribution story rests on that dir.
    if (f.name !== path.basename(f.name) || f.name === "." || f.name === "..") {
      skipped.push(`${f.name}: unsafe filename`);
      continue;
    }
    if (!Number.isFinite(f.bytes) || f.bytes <= 0) {
      skipped.push(`${f.name}: empty`);
      continue;
    }
    if (f.bytes > RUNNER_MAX_ARTIFACT_BYTES) {
      skipped.push(`${f.name}: over per-file cap (${f.bytes} bytes)`);
      continue;
    }
    usable.push(f);
  }

  const ordered = [...usable].sort(
    (a, b) => a.capturedAtMs - b.capturedAtMs || a.name.localeCompare(b.name),
  );
  const capturedTotal = ordered.length;
  const withSequence: SelectedArtifact[] = ordered.map((f, i) => ({
    name: f.name,
    bytes: f.bytes,
    capturedAt: new Date(f.capturedAtMs).toISOString(),
    sequence: i,
  }));

  const kept = withSequence.slice(Math.max(0, withSequence.length - RUNNER_MAX_ARTIFACTS_PER_STEP));
  if (kept.length < withSequence.length) {
    skipped.push(
      `${withSequence.length - kept.length} older image(s) dropped by the per-step cap (${RUNNER_MAX_ARTIFACTS_PER_STEP})`,
    );
  }

  return { kept, capturedTotal, skipped };
}

// NB: the step's output dir is CREATED by `writeStepMcpConfig` (claude.ts), not
// here — the function that writes the config naming the directory is the one
// that makes sure it exists, so there is a single owner of that mkdir.

/** Read a step's output dir. Returns [] when it is absent or unreadable — both
 *  mean "no evidence from this step", never an error. */
export async function collectStepArtifacts(dir: string): Promise<CapturedFile[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const out: CapturedFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const st = await stat(path.join(dir, e.name)).catch(() => null);
    if (!st) continue;
    out.push({ name: e.name, bytes: st.size, capturedAtMs: st.mtimeMs });
  }
  return out;
}

type Logger = { info: (m: string) => void; warn: (m: string) => void };

/** Injected uploader — one call per image, so a partial failure names the exact
 *  file that failed and leaves the rest stored. Returns false on any refusal. */
export type ArtifactUploader = (args: {
  runId: string;
  stepIdx: number;
  filename: string;
  bytes: Buffer;
  sequence: number;
  capturedTotal: number;
  capturedAt: string;
}) => Promise<boolean>;

/**
 * Collect, select and upload one step's captured images.
 *
 * Total by construction: every fs and network failure is caught and logged, and
 * the return value is informational. The caller invokes this AFTER posting the
 * step result, so nothing here can change a run's outcome — a screenshot that
 * fails to upload is a degraded run, never a failed one.
 */
export async function uploadStepArtifacts(args: {
  runId: string;
  stepIdx: number;
  dir: string;
  upload: ArtifactUploader;
  log?: Logger;
}): Promise<{ uploaded: number; capturedTotal: number }> {
  const { runId, stepIdx, dir, upload, log } = args;
  try {
    const files = await collectStepArtifacts(dir);
    if (files.length === 0) return { uploaded: 0, capturedTotal: 0 };

    const selection = selectArtifactsToUpload(files);
    for (const s of selection.skipped) log?.warn(`browser artifact skipped — ${s}`);
    if (selection.kept.length === 0) return { uploaded: 0, capturedTotal: selection.capturedTotal };

    let uploaded = 0;
    for (const item of selection.kept) {
      try {
        const bytes = await readFile(path.join(dir, item.name));
        // Re-check the size against what we actually read: the stat could be
        // stale if the file was still being written when we listed the dir.
        if (bytes.byteLength === 0 || bytes.byteLength > RUNNER_MAX_ARTIFACT_BYTES) {
          log?.warn(`browser artifact ${item.name} size changed on read — skipping`);
          continue;
        }
        const ok = await upload({
          runId,
          stepIdx,
          filename: item.name,
          bytes,
          sequence: item.sequence,
          capturedTotal: selection.capturedTotal,
          capturedAt: item.capturedAt,
        });
        if (ok) uploaded++;
      } catch (err) {
        log?.warn(
          `browser artifact ${item.name} upload errored: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (uploaded > 0 || selection.capturedTotal > 0) {
      log?.info(
        `browser artifacts run=${runId} step=${stepIdx} captured=${selection.capturedTotal} uploaded=${uploaded}`,
      );
    }
    return { uploaded, capturedTotal: selection.capturedTotal };
  } catch (err) {
    log?.warn(
      `browser artifact upload failed for run=${runId} step=${stepIdx}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { uploaded: 0, capturedTotal: 0 };
  }
}

/** Remove one step's artifact dir once its images have been shipped. The remote
 *  copy is now the record; leaving the local one is what made the old fixed
 *  output dir grow without bound. Best-effort. */
export async function cleanupStepArtifacts(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Boot-time sweep: at startup no step is in flight on this host, so any leftover
 * artifact dir is a straggler from a runner that died mid-job. Remove the whole
 * root. Best-effort — mirrors sweepStaleAttachments.
 */
export async function sweepStaleBrowserArtifacts(tmpDir: string = os.tmpdir()): Promise<void> {
  await rm(browserArtifactsRootDir(tmpDir), { recursive: true, force: true }).catch(
    () => undefined,
  );
}
