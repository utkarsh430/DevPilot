// Every git call that talks to a remote must carry the FRESHLY RESOLVED token.
//
// This is a SOURCE SCAN rather than a runtime test, and deliberately so: both
// files below pull in `server-only` module chains and cannot be imported under
// Vitest at all — which is precisely the gap the original bug lived in.
// `landTicketFn` resolved a token and then dropped it on the floor, and nothing
// anywhere failed, because a discarded argument is invisible to a type checker
// and to every test that cannot load the module.
//
// The scan makes the omission a red test instead.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "../../..");

/** git subcommands that reach the network and therefore need a credential. */
const REMOTE_VERBS = ["fetch", "push", "clone", "ls-remote", "pull"];

/**
 * Every `gitExec(...)` call in `source`, as a rough text slice running from the
 * call to its terminating `);` at the same indentation. Rough is sufficient:
 * the assertion is "a remote verb and a token appear in the same call", and an
 * over-long slice can only make the test more permissive — never falsely red.
 */
function gitExecCalls(source: string): string[] {
  return source
    .split("gitExec(")
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf(");");
      return end === -1 ? chunk.slice(0, 400) : chunk.slice(0, end);
    });
}

/**
 * The git SUBCOMMAND a call runs — the first element of its argv array.
 *
 * Matching anywhere in the call would be wrong: `git stash push` contains
 * "push" and touches no remote, and a scan that flags it teaches the next
 * person to loosen the scan.
 */
function subcommandOf(call: string): string | null {
  const literal = call.match(/\[\s*"([^"]+)"/);
  if (literal?.[1]) return literal[1];
  // The argv can be a VARIABLE — `gitExec(cwd, pushArgs, …)` in the land
  // worker. A mutation dropping the token from exactly that call slipped
  // through an array-literal-only scan, which is the call that started this
  // whole bug, so a named argv is matched on the name.
  const identifier = call.match(/,\s*([A-Za-z_$][\w$]*)\s*,/);
  if (!identifier?.[1]) return null;
  const name = identifier[1].toLowerCase();
  return REMOTE_VERBS.find((verb) => name.includes(verb)) ?? null;
}

/** Source with `//` comments removed, so prose about the old shape is not a hit. */
function withoutComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/.*$/, ""))
    .join("\n");
}

function read(relative: string): string {
  return readFileSync(path.join(WEB_ROOT, relative), "utf8");
}

const TARGETS = ["lib/engine/land-worker.ts", "app/(app)/changes/actions.ts"] as const;

describe.each(TARGETS)("%s", (relative) => {
  const source = read(relative);

  it("passes a token to every git call that reaches a remote", () => {
    const offenders = gitExecCalls(source).filter((call) => {
      const verb = subcommandOf(call);
      return verb !== null && REMOTE_VERBS.includes(verb) && !call.includes("token");
    });
    expect(offenders).toEqual([]);
  });

  it("finds remote calls at all — the scan is not vacuous", () => {
    const remoteCalls = gitExecCalls(source).filter((call) => {
      const verb = subcommandOf(call);
      return verb !== null && REMOTE_VERBS.includes(verb);
    });
    expect(remoteCalls.length).toBeGreaterThan(0);
  });

  it("strips the workspace's baked-in credential before authenticating", () => {
    // Without this, git prefers the userinfo segment in the remote URL and the
    // token passed above is never consulted — the whole fix would be inert.
    // A CALL, not merely the import: leaving the import behind while deleting
    // the call is exactly the shape a careless edit produces, and it would make
    // the whole fix inert while reading as present.
    expect(source).toContain("ensureCredentialFreeOrigin(");
  });
});

describe("no web-side path writes a credential back into a remote URL", () => {
  it("never assigns a password onto a parsed git URL", () => {
    for (const relative of TARGETS) {
      const source = withoutComments(read(relative));
      expect(source).not.toMatch(/\.password\s*=/);
      expect(source).not.toContain("x-access-token:");
    }
  });
});

describe("land-worker's rebaseAndPush", () => {
  const source = read("lib/engine/land-worker.ts");

  it("takes the token as a REQUIRED argument", () => {
    const signature = source.slice(
      source.indexOf("async function rebaseAndPush(args: {"),
      source.indexOf("}): Promise<PrepResult>"),
    );
    expect(signature).toContain("token: string");
    // Optional would let a future call site silently reintroduce the bug.
    expect(signature).not.toContain("token?:");
  });
});
