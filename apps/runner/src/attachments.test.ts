// Phase 3 — ticket screenshot delivery on the runner side.
//
// Pure planner + prompt-section builder are the security-relevant parts (caps,
// no path traversal, temp OUTSIDE the workspace, untrusted fence), plus a small
// IO round-trip for download → cleanup using a fake fetch and a scratch temp dir.
//
// Run: tsx src/attachments.test.ts

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import {
  RUNNER_MAX_ATTACHMENTS,
  RUNNER_MAX_ATTACHMENT_BYTES,
  RUNNER_MAX_TOTAL_ATTACHMENT_BYTES,
  attachmentDirForRun,
  attachmentsRootDir,
  cleanupRunAttachments,
  downloadRunAttachments,
  planAttachmentDownloads,
  renderAttachmentPromptSection,
  type RunAttachment,
} from "./attachments.js";

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

const RUN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function att(over: Partial<RunAttachment> & { id: string; filename: string }): RunAttachment {
  return {
    id: over.id,
    mime: over.mime ?? "image/png",
    bytes: over.bytes ?? 1000,
    filename: over.filename,
    url: over.url ?? `https://storage.example/${over.filename}?sig=x`,
  };
}

console.log("attachments — temp path safety");

test("per-run dir is under the OS temp root, NEVER a git workspace", () => {
  const dir = attachmentDirForRun(RUN);
  assert.ok(dir.startsWith(attachmentsRootDir()), "dir under attachments root");
  assert.ok(dir.startsWith(os.tmpdir()), "attachments root under OS tmp");
  // The workspace root convention is <...>/workspaces/<id>; the temp dir must
  // share none of that path so a download can never land in a clone.
  assert.ok(!dir.includes(`${path.sep}workspaces${path.sep}`), "not under a workspaces/ dir");
});

test("runId is basename-guarded so it can't escape the root", () => {
  const dir = attachmentDirForRun("../../etc/evil");
  assert.equal(path.basename(dir), "evil");
  assert.ok(dir.startsWith(attachmentsRootDir()));
});

console.log("attachments — planAttachmentDownloads caps + traversal guard");

test("plans safe absolute paths under the per-run dir", () => {
  const plan = planAttachmentDownloads({
    runId: RUN,
    attachments: [att({ id: "1", filename: "11111111-0000-4000-8000-000000000001.png" })],
  });
  assert.equal(plan.files.length, 1);
  assert.equal(
    plan.files[0]!.absPath,
    path.join(attachmentDirForRun(RUN), "11111111-0000-4000-8000-000000000001.png"),
  );
});

test("rejects a filename with a path separator or traversal", () => {
  const plan = planAttachmentDownloads({
    runId: RUN,
    attachments: [
      att({ id: "1", filename: "../escape.png" }),
      att({ id: "2", filename: "sub/dir.png" }),
      att({ id: "3", filename: "..\\win.png" }),
      att({ id: "4", filename: ".." }),
      att({ id: "5", filename: "" }),
    ],
  });
  assert.equal(plan.files.length, 0);
  assert.equal(plan.skipped.length, 5);
});

test("rejects a non-http url", () => {
  const plan = planAttachmentDownloads({
    runId: RUN,
    attachments: [att({ id: "1", filename: "a.png", url: "file:///etc/passwd" })],
  });
  assert.equal(plan.files.length, 0);
});

test("caps count at RUNNER_MAX_ATTACHMENTS", () => {
  const attachments = Array.from({ length: RUNNER_MAX_ATTACHMENTS + 2 }, (_, i) =>
    att({ id: String(i), filename: `f${i}.png` }),
  );
  const plan = planAttachmentDownloads({ runId: RUN, attachments });
  assert.equal(plan.files.length, RUNNER_MAX_ATTACHMENTS);
});

test("drops an over-per-file-cap byte size", () => {
  const plan = planAttachmentDownloads({
    runId: RUN,
    attachments: [att({ id: "1", filename: "a.png", bytes: RUNNER_MAX_ATTACHMENT_BYTES + 1 })],
  });
  assert.equal(plan.files.length, 0);
});

test("caps aggregate bytes at RUNNER_MAX_TOTAL_ATTACHMENT_BYTES", () => {
  const eight = 8 * 1024 * 1024;
  const plan = planAttachmentDownloads({
    runId: RUN,
    attachments: [
      att({ id: "1", filename: "a.png", bytes: eight }),
      att({ id: "2", filename: "b.png", bytes: eight }),
      att({ id: "3", filename: "c.png", bytes: eight }),
    ],
  });
  assert.equal(plan.files.length, 2);
  const total = plan.files.reduce((s, f) => s + f.bytes, 0);
  assert.ok(total <= RUNNER_MAX_TOTAL_ATTACHMENT_BYTES);
});

test("de-duplicates by filename", () => {
  const plan = planAttachmentDownloads({
    runId: RUN,
    attachments: [att({ id: "1", filename: "same.png" }), att({ id: "2", filename: "same.png" })],
  });
  assert.equal(plan.files.length, 1);
});

console.log("attachments — renderAttachmentPromptSection fence");

test("returns empty string for no images", () => {
  assert.equal(renderAttachmentPromptSection([]), "");
});

test("lists absolute paths inside the untrusted fence with a Read instruction", () => {
  const s = renderAttachmentPromptSection(["/tmp/x/a.png", "/tmp/x/b.png"]);
  assert.ok(s.includes("⟦UNTRUSTED"), "opens the untrusted fence");
  assert.ok(s.includes("⟦/UNTRUSTED⟧"), "closes the untrusted fence");
  assert.ok(s.includes("/tmp/x/a.png") && s.includes("/tmp/x/b.png"), "lists both abs paths");
  assert.ok(/Read tool/i.test(s), "instructs to use the Read tool");
  assert.ok(/data, not instructions/i.test(s), "flags the images as untrusted data");
});

console.log("attachments — download → cleanup IO");

test("downloads via injected fetch, writes files, then cleanup removes the dir", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "dp-att-test-"));
  try {
    const bytes = Buffer.from("PNGDATA");
    const fakeFetch = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
    const { dir, paths } = await downloadRunAttachments({
      runId: RUN,
      attachments: [
        att({ id: "1", filename: "one.png", bytes: bytes.byteLength }),
        att({ id: "2", filename: "two.png", bytes: bytes.byteLength }),
      ],
      tmpDir: scratch,
      fetchImpl: fakeFetch,
    });
    assert.equal(paths.length, 2);
    for (const p of paths) {
      const st = await stat(p);
      assert.ok(st.isFile() && st.size === bytes.byteLength);
      assert.ok(p.startsWith(dir), "written under the per-run dir");
    }
    await cleanupRunAttachments(RUN, scratch);
    await assert.rejects(stat(dir), "per-run dir removed after cleanup");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a failing fetch drops that one image but keeps the rest", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "dp-att-test-"));
  try {
    const good = Buffer.from("OK");
    const fakeFetch = (async (url: string) =>
      url.includes("bad")
        ? new Response("nope", { status: 404 })
        : new Response(good, { status: 200 })) as unknown as typeof fetch;
    const { paths } = await downloadRunAttachments({
      runId: RUN,
      attachments: [
        att({ id: "1", filename: "good.png", bytes: good.byteLength, url: "https://s/good" }),
        att({ id: "2", filename: "bad.png", bytes: good.byteLength, url: "https://s/bad" }),
      ],
      tmpDir: scratch,
      fetchImpl: fakeFetch,
    });
    assert.equal(paths.length, 1);
    assert.ok(paths[0]!.endsWith("good.png"));
    await cleanupRunAttachments(RUN, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

await Promise.all(pending);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall attachments tests passed");
