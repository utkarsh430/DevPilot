// Browser artifacts — the runner half of carrying an agent's screenshots out
// of a run.
//
// Three properties are load-bearing and each is asserted with a control that
// would fail if the property were removed:
//
//   1. ATTRIBUTION. A step's output directory is unique to (runId, stepIdx).
//      That uniqueness is the entire basis for filing an image under a step, so
//      a test pins that two steps of one run — and two runs — never share one.
//   2. RETENTION. The per-step cap keeps the NEWEST images, assigns `sequence`
//      over the FULL capture-ordered list (so a kept tail reads as a tail), and
//      reports `capturedTotal` including what it dropped — which is what makes
//      the cap legible to the operator rather than a silent truncation.
//   3. DEGRADATION. An upload that fails — in every way it can fail — must
//      leave the caller with a normal return value and no exception. Evidence
//      handling runs after the step result is already posted, so a throw here
//      would be a crash in a `finally` block for the sake of a screenshot.
//
// Run: tsx src/browser-artifacts.test.ts

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile, utimes, readdir } from "node:fs/promises";
import {
  RUNNER_MAX_ARTIFACTS_PER_STEP,
  RUNNER_MAX_ARTIFACT_BYTES,
  browserArtifactDirForStep,
  browserArtifactsRootDir,
  cleanupStepArtifacts,
  collectStepArtifacts,
  selectArtifactsToUpload,
  sweepStaleBrowserArtifacts,
  uploadStepArtifacts,
  type ArtifactUploader,
  type CapturedFile,
} from "./browser-artifacts.js";

let failures = 0;
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      pending.push(
        r.then(
          () => console.log(`  ✓ ${name}`),
          (err) => {
            failures++;
            console.error(`  ✗ ${name}`);
            console.error(`    ${err instanceof Error ? err.message : String(err)}`);
          },
        ),
      );
    } else {
      console.log(`  ✓ ${name}`);
    }
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN = "22222222-2222-4222-8222-222222222222";

function file(name: string, capturedAtMs: number, bytes = 1024): CapturedFile {
  return { name, bytes, capturedAtMs };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Attribution — the directory IS the association.
// ───────────────────────────────────────────────────────────────────────────

console.log("attribution");

test("two steps of the same run never share an output dir", () => {
  const a = browserArtifactDirForStep(RUN, 0, "/tmp");
  const b = browserArtifactDirForStep(RUN, 1, "/tmp");
  assert.notEqual(a, b);
});

test("two runs never share an output dir (concurrency safety)", () => {
  const a = browserArtifactDirForStep(RUN, 0, "/tmp");
  const b = browserArtifactDirForStep(OTHER_RUN, 0, "/tmp");
  assert.notEqual(a, b);
});

test("the step dir is under the artifacts root, never a workspace", () => {
  const dir = browserArtifactDirForStep(RUN, 3, "/tmp");
  assert.ok(dir.startsWith(browserArtifactsRootDir("/tmp") + path.sep));
  // The step index is a real path segment, so a directory listing is readable.
  assert.ok(dir.endsWith(path.join(RUN, "3")));
});

test("a path-shaped runId cannot escape the artifacts root", () => {
  const dir = browserArtifactDirForStep("../../etc", 0, "/tmp");
  assert.ok(dir.startsWith(browserArtifactsRootDir("/tmp") + path.sep));
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Retention — the cap keeps the newest and says what it dropped.
// ───────────────────────────────────────────────────────────────────────────

console.log("\nretention");

test("under the cap, everything is kept and capturedTotal matches", () => {
  const sel = selectArtifactsToUpload([file("a.png", 100), file("b.png", 200)]);
  assert.equal(sel.kept.length, 2);
  assert.equal(sel.capturedTotal, 2);
  assert.deepEqual(
    sel.kept.map((k) => k.name),
    ["a.png", "b.png"],
  );
});

test("over the cap, the NEWEST are kept", () => {
  const files = Array.from({ length: 9 }, (_, i) => file(`shot-${i}.png`, 1_000 + i * 10));
  const sel = selectArtifactsToUpload(files);
  assert.equal(sel.kept.length, RUNNER_MAX_ARTIFACTS_PER_STEP);
  assert.deepEqual(
    sel.kept.map((k) => k.name),
    ["shot-5.png", "shot-6.png", "shot-7.png", "shot-8.png"],
  );
});

test("capturedTotal reports what was DROPPED, not what was kept", () => {
  // This is the property that makes the cap legible rather than silent: if this
  // reported `kept.length`, the inspector would say "4 images" for a step that
  // captured 9 and the operator would never know 5 exist elsewhere.
  const files = Array.from({ length: 9 }, (_, i) => file(`shot-${i}.png`, 1_000 + i * 10));
  const sel = selectArtifactsToUpload(files);
  assert.equal(sel.capturedTotal, 9);
  assert.notEqual(sel.capturedTotal, sel.kept.length);
  assert.ok(sel.skipped.some((s) => s.includes("per-step cap")));
});

test("sequence is assigned over the FULL list, so a kept tail reads as a tail", () => {
  const files = Array.from({ length: 9 }, (_, i) => file(`shot-${i}.png`, 1_000 + i * 10));
  const sel = selectArtifactsToUpload(files);
  assert.deepEqual(
    sel.kept.map((k) => k.sequence),
    [5, 6, 7, 8],
  );
});

test("capture order is by mtime, not by directory order", () => {
  const sel = selectArtifactsToUpload([file("z.png", 100), file("a.png", 500)]);
  assert.deepEqual(
    sel.kept.map((k) => k.name),
    ["z.png", "a.png"],
  );
});

test("same-mtime files order deterministically by name", () => {
  const a = selectArtifactsToUpload([file("b.png", 100), file("a.png", 100)]);
  const b = selectArtifactsToUpload([file("a.png", 100), file("b.png", 100)]);
  assert.deepEqual(
    a.kept.map((k) => k.name),
    b.kept.map((k) => k.name),
  );
});

test("non-image files are not evidence and are silently ignored", () => {
  // @playwright/mcp also writes page snapshots into this directory.
  const sel = selectArtifactsToUpload([
    file("page.yml", 100),
    file("trace.zip", 110),
    file("shot.png", 120),
  ]);
  assert.equal(sel.capturedTotal, 1);
  assert.deepEqual(
    sel.kept.map((k) => k.name),
    ["shot.png"],
  );
});

test("an oversized file is dropped with a stated reason, not truncated", () => {
  const sel = selectArtifactsToUpload([
    file("huge.png", 100, RUNNER_MAX_ARTIFACT_BYTES + 1),
    file("ok.png", 110),
  ]);
  assert.deepEqual(
    sel.kept.map((k) => k.name),
    ["ok.png"],
  );
  assert.ok(sel.skipped.some((s) => s.includes("huge.png") && s.includes("per-file cap")));
});

test("an empty file is dropped", () => {
  const sel = selectArtifactsToUpload([file("empty.png", 100, 0)]);
  assert.equal(sel.kept.length, 0);
  assert.ok(sel.skipped.some((s) => s.includes("empty")));
});

test("a filename with a separator is refused", () => {
  const sel = selectArtifactsToUpload([file("../escape.png", 100)]);
  assert.equal(sel.kept.length, 0);
  assert.ok(sel.skipped.some((s) => s.includes("unsafe filename")));
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Degradation — every failure mode leaves the run alone.
// ───────────────────────────────────────────────────────────────────────────

console.log("\ndegradation");

async function withScratch(fn: (scratch: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "devpilot-artifact-test-"));
  try {
    await fn(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

async function seedStep(scratch: string, names: string[]): Promise<string> {
  const dir = browserArtifactDirForStep(RUN, 0, scratch);
  await mkdir(dir, { recursive: true });
  let t = Date.now() / 1000;
  for (const n of names) {
    const p = path.join(dir, n);
    await writeFile(p, PNG);
    t += 1;
    await utimes(p, t, t);
  }
  return dir;
}

test("a healthy step uploads its images", async () => {
  await withScratch(async (scratch) => {
    const dir = await seedStep(scratch, ["a.png", "b.png"]);
    const seen: string[] = [];
    const upload: ArtifactUploader = async (a) => {
      seen.push(a.filename);
      return true;
    };
    const res = await uploadStepArtifacts({ runId: RUN, stepIdx: 0, dir, upload });
    assert.equal(res.uploaded, 2);
    assert.equal(res.capturedTotal, 2);
    assert.deepEqual(seen.sort(), ["a.png", "b.png"]);
  });
});

test("an uploader that REFUSES every image resolves normally (degraded, not failed)", async () => {
  await withScratch(async (scratch) => {
    const dir = await seedStep(scratch, ["a.png", "b.png"]);
    const upload: ArtifactUploader = async () => false;
    const res = await uploadStepArtifacts({ runId: RUN, stepIdx: 0, dir, upload });
    assert.equal(res.uploaded, 0);
    // The step's capture count is still known — the operator learns images
    // existed even though none were stored.
    assert.equal(res.capturedTotal, 2);
  });
});

test("an uploader that THROWS does not propagate", async () => {
  await withScratch(async (scratch) => {
    const dir = await seedStep(scratch, ["a.png"]);
    const upload: ArtifactUploader = async () => {
      throw new Error("engine unreachable");
    };
    // No assert.rejects here on purpose: the whole point is that this resolves.
    const res = await uploadStepArtifacts({ runId: RUN, stepIdx: 0, dir, upload });
    assert.equal(res.uploaded, 0);
  });
});

test("a partial failure still stores the images that worked", async () => {
  await withScratch(async (scratch) => {
    const dir = await seedStep(scratch, ["a.png", "b.png", "c.png"]);
    const upload: ArtifactUploader = async (a) => {
      if (a.filename === "b.png") throw new Error("boom");
      return true;
    };
    const res = await uploadStepArtifacts({ runId: RUN, stepIdx: 0, dir, upload });
    assert.equal(res.uploaded, 2);
  });
});

test("a missing output dir is 'captured nothing', not an error", async () => {
  await withScratch(async (scratch) => {
    const dir = browserArtifactDirForStep(RUN, 7, scratch);
    const res = await uploadStepArtifacts({
      runId: RUN,
      stepIdx: 7,
      dir,
      upload: async () => true,
    });
    assert.equal(res.uploaded, 0);
    assert.equal(res.capturedTotal, 0);
  });
});

test("collectStepArtifacts on an unreadable dir returns []", async () => {
  const files = await collectStepArtifacts("/definitely/not/a/real/dir/anywhere");
  assert.deepEqual(files, []);
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Lifecycle — the local copy does not outlive the step.
// ───────────────────────────────────────────────────────────────────────────

console.log("\nlifecycle");

test("cleanupStepArtifacts removes the step dir", async () => {
  await withScratch(async (scratch) => {
    const dir = await seedStep(scratch, ["a.png"]);
    await cleanupStepArtifacts(dir);
    const entries = await readdir(dir).catch(() => null);
    assert.equal(entries, null);
  });
});

test("cleanup of an absent dir is a no-op, not a throw", async () => {
  await cleanupStepArtifacts("/definitely/not/a/real/dir/anywhere");
});

test("the boot sweep removes the whole root", async () => {
  await withScratch(async (scratch) => {
    await seedStep(scratch, ["a.png"]);
    await sweepStaleBrowserArtifacts(scratch);
    const entries = await readdir(browserArtifactsRootDir(scratch)).catch(() => null);
    assert.equal(entries, null);
  });
});

await Promise.all(pending);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall browser-artifact tests passed");
