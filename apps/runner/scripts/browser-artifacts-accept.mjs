#!/usr/bin/env node
// Acceptance check: the assumptions our screenshot collection makes about
// @playwright/mcp are TRUE OF THE REAL BINARY.
//
// Why this exists as a script and not a unit test: every property below is a
// fact about a third-party program's behaviour, and a hand-written fixture
// would be invented with exactly the shape our code already expects — which
// proves nothing. (Same reasoning as scripts/vercel-accept.mjs and
// scripts/export-fonts-accept.mjs: a 403 classified from a fixture nobody
// observed is a guess with a test around it.)
//
// It is NOT in `pnpm test`: it launches a real Chromium, so it needs
// `npx playwright install chromium` and takes seconds, not milliseconds. Run it
// when bumping the pinned @playwright/mcp version — that is the moment these
// assumptions can silently stop holding, and the failure mode is invisible
// (screenshots simply stop being collected; no run fails, no error appears).
//
//   pnpm --filter @devpilot/runner accept:browser-artifacts
//
// What it pins, and what breaks if each stops being true:
//
//   1. Screenshots land FLAT in --output-dir, not in a subdirectory.
//      `collectStepArtifacts` reads top-level files only, so a subdirectory
//      would mean it silently finds nothing.
//   2. --output-dir is HONOURED at all. If it were ignored, captures would land
//      in the agent's git workspace (the reason the flag was added) AND would be
//      unattributable to a step.
//   3. The image extension is one we recognise (.png/.jpeg/.jpg).
//      `selectArtifactsToUpload` filters on it; an unrecognised one drops
//      everything on the floor.
//   4. The bytes are a real PNG/JPEG by signature. The ingest route sniffs magic
//      bytes and REFUSES a mismatch, so a format change becomes a 415 per image.
//   5. Non-image files ARE also written to the same directory (page snapshots).
//      This is why the extension filter exists rather than uploading everything.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "node_modules", ".bin", "playwright-mcp");
const OUT = path.join(os.tmpdir(), `devpilot-artifact-accept-${process.pid}`);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

function sniff(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  if (!fs.existsSync(BIN)) {
    console.error(`playwright-mcp not found at ${BIN} — run pnpm install first.`);
    process.exit(1);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // Spawned exactly as apps/runner/src/claude.ts spawns it.
  const proc = spawn(BIN, ["--headless", "--isolated", "--output-dir", OUT], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let buf = "";
  let nextId = 0;
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* non-JSON banner line */
      }
    }
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 90_000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "devpilot-artifact-accept", version: "1" },
    });
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    await call("tools/call", {
      name: "browser_navigate",
      arguments: { url: "data:text/html,<h1>devpilot artifact acceptance</h1>" },
    });
    const shot = await call("tools/call", {
      name: "browser_take_screenshot",
      arguments: {},
    });
    check(
      "browser_take_screenshot returns a result",
      !shot.error,
      JSON.stringify(shot.error ?? ""),
    );

    // (2) --output-dir is honoured: something was written there at all.
    const top = fs.readdirSync(OUT, { withFileTypes: true });
    check("--output-dir is honoured (files were written there)", top.length > 0);

    // (1) Flat, not nested. This is the one that would silently zero out
    //     collection, so report the offending directory names when it fails.
    const dirs = top.filter((e) => e.isDirectory()).map((e) => e.name);
    check(
      "screenshots land FLAT in --output-dir (no subdirectories)",
      dirs.length === 0,
      dirs.length ? `found subdirectories: ${dirs.join(", ")}` : "",
    );

    const files = top.filter((e) => e.isFile()).map((e) => e.name);
    const images = files.filter((n) => IMAGE_EXTENSIONS.has(path.extname(n).toLowerCase()));

    // (3) At least one file carries an extension our selector recognises.
    check(
      "the capture has a recognised image extension",
      images.length > 0,
      `files written: ${files.join(", ") || "(none)"}`,
    );

    // (4) The bytes really are PNG/JPEG — the ingest route sniffs and refuses
    //     anything else, so a format change here becomes a 415 per image.
    for (const name of images) {
      const bytes = fs.readFileSync(path.join(OUT, name));
      const mime = sniff(bytes);
      check(`${name} is a real PNG/JPEG by signature`, mime !== null, `sniffed: ${mime}`);
      check(`${name} is non-empty`, bytes.byteLength > 0);
    }

    // (5) Non-image files share the directory — the reason we filter rather
    //     than uploading the whole directory.
    const nonImages = files.filter((n) => !IMAGE_EXTENSIONS.has(path.extname(n).toLowerCase()));
    if (nonImages.length > 0) {
      console.log(
        `  · note: ${nonImages.length} non-image file(s) also written (${nonImages.join(", ")}) — the extension filter is load-bearing`,
      );
    }
  } finally {
    proc.kill();
    fs.rmSync(OUT, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} acceptance check(s) failed`);
    process.exit(1);
  }
  console.log("\nbrowser-artifact acceptance checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
