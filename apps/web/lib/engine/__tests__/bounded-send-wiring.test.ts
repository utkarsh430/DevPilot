// THE SWEEP, ENFORCED.
//
// `inngest.send()` ends in a `fetch` with no timeout. On a request path - a
// server action or a route handler - an unresponsive event endpoint therefore
// does not fail, it HANGS, and every statement after the emit is never reached.
// That is the 2026-08-01 "Discard & restart hangs forever" defect, and the same
// shape existed at ~25 other call sites.
//
// A shared helper only fixes that for as long as every future call site
// remembers to use it, and this repo has been bitten by exactly that kind of
// drift before (`DEVPILOT_BOARD_TOOLS`). So the rule is checked rather than
// documented: a RAW `inngest.send` may appear only in a file listed in
// `BACKGROUND_ONLY_EMITTERS` below, and each entry carries the reason it is
// safe. The list doubles as the sweep's written record.
//
// This has to be a SOURCE SCAN. Every one of these files reaches `server-only`
// or `next/headers` and cannot load under Vitest - which is precisely the gap
// the defect lived in. Same reasoning, same shape, as
// `nothing-to-land-wiring.test.ts` and `landed-push-wiring.test.ts`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Files permitted to call `inngest.send` directly.
 *
 * The rule: a send is exempt when it can only ever run INSIDE an Inngest durable
 * function or cron. Inngest already bounds a step with its own timeout and
 * retries it, so adding a second, shorter bound there would convert a
 * slow-but-healthy send into a spurious step failure - strictly worse. Nothing
 * is blocked on the HTTP response of a request in these paths, because there is
 * no request.
 *
 * Verified reachability (2026-08-01): none of these modules is imported by a
 * server action or a route handler. The only `app/` importer of any of them is
 * `app/api/inngest/route.ts`, which REGISTERS the functions with the serve
 * handler rather than calling them.
 */
const BACKGROUND_ONLY_EMITTERS: Record<string, string> = {
  "lib/engine/send-bounded.ts": "the bounded wrapper itself - the one legitimate raw caller",
  "lib/engine/aggregator.ts": "fan-in aggregator; runs only inside `aggregateFanOutFn`",
  "lib/engine/land-worker.ts": "`landTicketFn` + the integration-queue reaper cron",
  "lib/engine/run-agent.ts": "the `runAgent` durable function's own step body",
  "lib/engine/supervision.ts": "reached only from `run-agent.ts`",
  "lib/engine/ticket-reconciler.ts":
    "reached from `run-agent.ts` and the stuck-ticket sweeper cron",
  "lib/engine/ticket-scheduler.ts": "`drainBacklogFn`'s window loop",
  // The raw send lives ONLY inside `defaultDispatchRescueDeps`, which is called
  // only by `dispatchRescueReaper`'s cron. Note the qualifier: since the project
  // supervisor landed, this FILE is also imported by a request path
  // (`app/api/runners/supervision/route.ts` → `releaseGroup`), but that path
  // builds its OWN deps in `supervisor-store.ts` with a `sendEventBounded`
  // emitter precisely because it runs when the event endpoint is known to be
  // sick. Do not move a raw send out of `defaultDispatchRescueDeps` into a
  // function a request path can reach.
  "lib/engine/dispatch-rescue-store.ts":
    "raw send confined to `defaultDispatchRescueDeps`, called only by the 5-minute cron sweep",
  "lib/roles/postprocess.ts": "reached only from `run-agent.ts`'s `role-post` step",
};

/**
 * Blank out comments and string/template literals so a send named in prose or in
 * a log message is not mistaken for a call.
 *
 * A hand-rolled state machine rather than a chain of `.replace()`s, because the
 * regex version is quietly wrong and the way it is wrong is invisible: an
 * apostrophe in a comment ("don't"), or one stray backtick, pairs with a quote
 * hundreds of lines later and blanks the real code in between. The first draft
 * of this file did exactly that and silently stopped seeing
 * `ticket-reconciler.ts`'s emit - a scanner that under-reports is worse than no
 * scanner, since it reads as a clean sweep. The allowlist-staleness case below
 * is what caught it, and is why it stays.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  // Tracks whether a `/` can start a regex literal here (it can after an
  // operator or an opening bracket, not after a value).
  let regexAllowed = true;
  while (i < src.length) {
    const c = src[i] ?? "";
    const next = src[i + 1] ?? "";
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      regexAllowed = false;
      continue;
    }
    if (c === "/" && regexAllowed) {
      // A regex literal: skip it, so a `'` or a backtick inside a character
      // class cannot open a phantom string.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        i = j;
        out += " ";
        regexAllowed = false;
        continue;
      }
    }
    if (!/\s/.test(c)) regexAllowed = /[(,=:[!&|?{};+\-*%<>~^]/.test(c);
    out += c;
    i++;
  }
  return out;
}

const RAW_SEND = /\binngest\s*\.\s*send\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; code: string }[] {
  return [join(WEB_ROOT, "app"), join(WEB_ROOT, "lib")]
    .flatMap((root) => walk(root))
    .map((full) => ({
      rel: relative(WEB_ROOT, full).split(sep).join("/"),
      full,
    }))
    .filter((f) => !f.rel.includes("__tests__/"))
    .map((f) => ({ rel: f.rel, code: stripCommentsAndStrings(readFileSync(f.full, "utf8")) }));
}

describe("bounded inngest sends", () => {
  const files = sourceFiles();

  it("scans a non-trivial number of files (guards against a vacuous walk)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no request-path module calls inngest.send directly", () => {
    const offenders = files
      .filter((f) => RAW_SEND.test(f.code))
      .map((f) => f.rel)
      .filter((rel) => !(rel in BACKGROUND_ONLY_EMITTERS))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("the background allowlist is not stale - every entry still exists and still emits", () => {
    const byRel = new Map(files.map((f) => [f.rel, f.code]));
    for (const rel of Object.keys(BACKGROUND_ONLY_EMITTERS)) {
      const code = byRel.get(rel);
      expect(code, `${rel} is allowlisted but no longer scanned`).toBeDefined();
      expect(RAW_SEND.test(code ?? ""), `${rel} no longer emits - drop it from the list`).toBe(
        true,
      );
    }
  });

  it("every allowlist entry carries a reason", () => {
    for (const rel of Object.keys(BACKGROUND_ONLY_EMITTERS)) {
      const reason = BACKGROUND_ONLY_EMITTERS[rel] ?? "";
      expect(reason.length, `${rel} needs a reason, not an empty string`).toBeGreaterThan(10);
    }
  });

  it("the two operator restart paths bound the cleanup step they are blocked on", () => {
    // `requestWorkspaceReset` is a DB read PLUS an emit, and the operator waits
    // on the whole thing - so these bound the step, not just the last hop. The
    // discard path bounds it inside `runDiscardAndRestart`; the reopen path
    // bounds it at its own call site. Both modules reach `next/headers`, so this
    // is the only place the wiring can be asserted.
    const actions = readFileSync(
      join(WEB_ROOT, "app/(app)/projects/[projectId]/integration-actions.ts"),
      "utf8",
    );
    expect(actions).toContain("withSendTimeout");
    expect(actions).toMatch(/withSendTimeout\(\s*\(\)\s*=>\s*\n?\s*requestWorkspaceReset\(/);
    expect(actions).toContain("runDiscardAndRestart");

    const core = readFileSync(join(WEB_ROOT, "lib/board/discard-restart.ts"), "utf8");
    expect(core).toMatch(/withSendTimeout\(\(\)\s*=>\s*effects\.requestWorkspaceReset\(\)/);
  });

  it("only the discard path asks requestWorkspaceReset for the reap-guard bypass", () => {
    // Unrelated to the timeout, and pinned precisely BECAUSE this change moved
    // the surrounding code: `force: true` is the sanctioned bypass of the
    // unpushed-work reap guard and must stay set on this one path. (Matches the
    // CALL, not the flag - `reset.server.ts` legitimately forwards it onward.)
    const callers = files
      .filter((f) => /requestWorkspaceReset\(\{[^}]*force:\s*true/s.test(f.code))
      .map((f) => f.rel);
    expect(callers).toEqual(["app/(app)/projects/[projectId]/integration-actions.ts"]);
  });
});
