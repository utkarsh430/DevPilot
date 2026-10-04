// Source-scan guards for the console's wiring.
//
// These are claims about EVERY path rather than about one call, which is what a
// runtime test cannot make - and the two files they most need to cover
// (`console-server-actions.ts`, which reaches `next/headers`, and
// `console-store.server.ts`, which reaches `server-only`) cannot load under
// Vitest at all. That is precisely the gap defects in this codebase keep living
// in, so the properties are asserted against the source text.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "lib", "supervisor");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

describe("the marker-free split holds", () => {
  it("only the `.server.ts` twins import `server-only`", () => {
    // The decision modules must stay loadable under Vitest. A `server-only`
    // import in any of them silently removes the whole console from the suite.
    for (const f of files) {
      const hasMarker = /^import "server-only";/m.test(read(f));
      expect(hasMarker, `${f} imports server-only`).toBe(f.endsWith(".server.ts"));
    }
  });

  it("no decision module imports a recovery primitive as a VALUE", () => {
    // `releaseGroup` and `recoverOrphanedTicket` both reach `server-only`, so a
    // value import would break the split above. They arrive as injected deps.
    for (const f of files.filter((f) => !f.endsWith(".server.ts"))) {
      const src = read(f);
      expect(src, f).not.toMatch(/import\s*\{[^}]*\breleaseGroup\b/);
      expect(src, f).not.toMatch(/import\s*\{[^}]*\brecoverOrphanedTicket\b/);
    }
  });
});

describe("the console reimplements no recovery", () => {
  it("wires the crons' OWN primitives, not a reimplementation", () => {
    // Detection is `detectDispatchStall`/`decideOrphanRecovery` and remediation
    // is `releaseGroup`/`recoverOrphanedTicket`. A second opinion about what
    // counts as broken is how a supervisor starts fighting the reapers.
    const wiring = read("console-store.server.ts");
    expect(wiring).toContain("releaseGroup(dispatchDeps, group)");
    expect(wiring).toContain("recoverOrphanedTicket(orphanDeps, candidate)");
  });

  it("moves a ticket ONLY through the injected primitive", () => {
    // No direct `transitionTicket`, no direct `dispatch_queue` claim, and no
    // ticket UPDATE anywhere in the store: a second write path would be a
    // second policy, and the primitives' re-derivation is what makes commanded
    // action safe at all.
    const store = read("console-store.ts");
    expect(store).not.toContain("transitionTicket");
    expect(store).not.toContain("claimNext");
    expect(store).not.toMatch(/\.from\("tickets"\)[\s\S]{0,200}\.update\(/);
  });

  it("writes to exactly one table, and it is the ledger", () => {
    const store = read("console-store.ts");
    const inserts = [...store.matchAll(/\.from\("([a-z_]+)"\)\s*\.insert\(/g)].map((m) => m[1]);
    expect(inserts).toEqual(["supervisor_actions"]);
    expect(store).not.toMatch(/\.delete\(\)/);
  });
});

describe("the transcript", () => {
  const store = read("console-history-store.ts");

  it("touches exactly one table, and it is the transcript", () => {
    // A transcript module that could write anywhere else would be a second,
    // unreviewed write path into the board's own tables.
    const tables = [...store.matchAll(/\.from\(([A-Za-z_"]+)\)/g)].map((m) => m[1]);
    expect([...new Set(tables)]).toEqual(["TABLE"]);
    expect(store).toMatch(/const TABLE = "supervisor_console_messages"/);
  });

  it("is append-only: no update, no delete", () => {
    // A turn is a record of what was said, and the ledger points at it. Editing
    // one would make `console_message_id` a link to text that has since changed;
    // deleting one would erase what was asked before a sweep, which is exactly
    // the provenance this table exists to establish.
    expect(store).not.toMatch(/\.update\(/);
    expect(store).not.toMatch(/\.delete\(/);
  });

  it("scopes EVERY read by tenant AND project", () => {
    // Service-role with RLS off, so these predicates are the entire boundary.
    // Both matter and they fail differently: a missing tenant predicate replays
    // another workspace's conversation into this one's model context; a missing
    // project one replays a different board's.
    const selects = [
      ...store.matchAll(/\.select\(SELECT_COLUMNS\)([\s\S]{0,400}?)(?=\n\s*if \()/g),
    ];
    expect(selects.length, "no scoped SELECT found - has the store been rewritten?").toBe(2);
    for (const [, body] of selects) {
      expect(body).toContain('.eq("tenant_id"');
      expect(body).toContain('.eq("project_id"');
    }
  });

  it("stamps the tenant and the project on the write", () => {
    expect(store).toMatch(/tenant_id:\s*args\.tenantId/);
    expect(store).toMatch(/project_id:\s*args\.projectId/);
  });

  it("never throws - a lost record must not fail the conversation", () => {
    // Both public IO functions are wrapped. A transcript write that could throw
    // would take down a board recovery because the console could not write down
    // that it happened.
    expect((store.match(/\bcatch\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the conversation is persisted, and the model's context comes from it", () => {
  const actions = read("console-server-actions.ts");

  it("records the operator's message BEFORE the model is called", () => {
    // A question that timed out is exactly the one an operator comes back to,
    // and it is the message a command from that turn is attributed to.
    const asked = actions.indexOf('kind: "ask"');
    const answered = actions.indexOf("answerConsoleQuestion(");
    expect(asked, "no operator turn is recorded").toBeGreaterThan(0);
    expect(asked).toBeLessThan(answered);
  });

  it("records the console's side too - answer, failure and outcome", () => {
    for (const kind of ["answer", "model_failure", "notice", "action_result"]) {
      expect(actions, kind).toContain(`kind: "${kind}"`);
    }
  });

  it("takes NO history from the client", () => {
    // It used to: `history` was a request field, so a client could put any text
    // it liked into the prompt as "earlier in this conversation". Fenced, but a
    // client-controlled prompt input for no reason. The window now comes from
    // the transcript.
    expect(actions).not.toMatch(/history\??\s*:\s*ConsoleTurn\[\]/);
    expect(actions).not.toMatch(/input\.history/);
    expect(actions).toContain("loadConsoleThread(");
    const consoleTsx = readFileSync(
      join(process.cwd(), "components", "supervisor", "SupervisorConsole.tsx"),
      "utf8",
    );
    expect(consoleTsx).not.toMatch(/askSupervisorConsoleAction\([^)]*history/);
  });

  it("bounds the replayed window", () => {
    expect(actions).toContain("CONSOLE_HISTORY_CONTEXT_TURNS");
    expect(actions).toContain("toModelContextTurns(");
  });

  it("the client's loaded-thread flag is keyed on the PROJECT, not a bare boolean", () => {
    // A thread is per project, and the component can be handed a new projectId
    // WITHOUT unmounting (the operator switches board from the topbar). A plain
    // `threadLoaded` boolean would keep the previous board's conversation on
    // screen under the new board's name and never fetch the new one - the same
    // cross-board confusion the project-scoped table prevents at the database,
    // arriving through the client instead.
    const consoleTsx = readFileSync(
      join(process.cwd(), "components", "supervisor", "SupervisorConsole.tsx"),
      "utf8",
    );
    expect(consoleTsx).not.toMatch(
      /useState\(false\);\s*\n\s*React\.useEffect\(\(\) => \{\s*\n\s*if \(!open \|\| threadLoaded\)/,
    );
    expect(consoleTsx).toMatch(/threadFor === projectId/);
    expect(consoleTsx).toMatch(/setThreadFor\(projectId\)/);
    // And the locally-appended turns go with it - they belong to the board they
    // were typed on.
    expect(consoleTsx).toMatch(/threadFor !== projectId[\s\S]{0,240}setTurns\(\[\]\)/);
  });
});

describe("a commanded fix is linked to the message that caused it", () => {
  const actions = read("console-server-actions.ts");

  it("proves the link rather than trusting the client's id", () => {
    // The id is client-supplied. It is not a security input - the target still
    // comes from re-parsing `question` - but a link to an unrelated message is
    // a confidently wrong audit trail, which is worse than a missing one.
    expect(actions).toContain("decideConsoleMessageLink(");
    expect(actions).toContain("loadConsoleMessageById(");
    expect(actions).toMatch(/consoleMessageId:\s*link\.link\s*\?\s*link\.messageId\s*:\s*null/);
    // The raw client value must never reach the store.
    expect(actions).not.toMatch(/consoleMessageId:\s*input\.consoleMessageId/);
  });

  it("the target is STILL derived from the operator's own words", () => {
    // The link changes nothing about what may be commanded. `question` is what
    // `runConsoleCommand` re-parses, and it is still what is passed.
    expect(actions).toMatch(/runConsoleCommand\(deps,\s*\{[\s\S]{0,300}question,/);
  });

  it("carries the link all the way to the ledger row", () => {
    expect(read("command-store.ts")).toMatch(/consoleMessageId:\s*args\.consoleMessageId/);
    expect(read("console-store.ts")).toMatch(/console_message_id:\s*row\.consoleMessageId/);
  });
});

describe("the emit is bounded on this request path", () => {
  it("uses `sendEventBounded`, never a raw `inngest.send`", () => {
    // `inngest.send` has no timeout: against a wedged event endpoint it never
    // settles, so no `catch` runs and the operator watches a spinner forever
    // while the release has already succeeded. This is a request path, and it
    // runs exactly when the endpoint is most likely to be sick.
    const wiring = read("console-store.server.ts");
    expect(wiring).toContain("sendEventBounded");
    expect(wiring).not.toMatch(/\binngest\.send\(/);
  });
});

describe("the model call goes through the one seam", () => {
  it("uses `generateObjectForTenant` and no vendor SDK", () => {
    const answer = read("console-answer.server.ts");
    expect(answer).toContain("generateObjectForTenant");
    expect(answer).not.toMatch(/@ai-sdk\//);
    expect(answer).not.toMatch(/from "ai"/);
    expect(answer).not.toMatch(/\bgenerateObject\(/);
  });

  it("asks for the heavy (Opus) tier", () => {
    // The one surface where reasoning quality outranks cost - see the file
    // header. A silent downgrade to `cheap` would keep every test green.
    expect(read("console-answer.server.ts")).toMatch(/tier:\s*"heavy"/);
  });
});

describe("the server-action layer holds no policy", () => {
  it("routes ACT through `runConsoleAction` rather than touching a primitive", () => {
    const actions = read("console-server-actions.ts");
    expect(actions).toContain("runConsoleAction");
    expect(actions).not.toContain("releaseQueue");
    expect(actions).not.toContain("recoverTicket");
  });

  it("takes no tenant id from the caller", () => {
    // Every export is a browser-reachable endpoint. The tenant comes from the
    // session and the project is then checked against it; accepting one would
    // make the whole boundary a suggestion.
    const actions = read("console-server-actions.ts");
    expect(actions).toContain("requireTenantId()");
    expect(actions).not.toMatch(/input\.tenantId/);
    expect(actions).not.toMatch(/tenantId\s*[:?]\s*string;?\s*\n\s*(question|actionId|projectId)/);
  });
});

describe("the model-failure sentence is chosen by kind, everywhere", () => {
  // `SupervisorConsole.tsx` is `"use client"` and carries hooks, so it does not
  // load under the repo's node-environment Vitest — which is exactly where this
  // defect lived: the wording was hardcoded in a file no test could execute.
  const consoleTsx = readFileSync(
    join(process.cwd(), "components", "supervisor", "SupervisorConsole.tsx"),
    "utf8",
  );

  it("the component asks `describeConsoleModelFailure` and hardcodes nothing", () => {
    expect(consoleTsx).toContain("describeConsoleModelFailure(");
    // THE regression, as a literal. This exact prefix was applied to every
    // failure, including a reply that arrived and would not parse.
    expect(consoleTsx).not.toContain("I could not reach the model to write that up");
  });

  it("the `kind` survives every hop from the seam to the sentence", () => {
    // Three files, none of which loads under Vitest, and the discriminator is
    // useless if any one of them drops it.
    expect(read("console-answer.server.ts")).toContain("kind: res.kind");
    const actions = read("console-server-actions.ts");
    expect(actions).toContain("failureKind: answered.kind");
    expect(consoleTsx).toContain("res.failureKind");
  });

  it("`generateObjectForTenant` classifies EVERY failure it returns", () => {
    // A missing `kind` is a type error; a MISSING BRANCH is not, because a new
    // early return is simply a new place to forget. So the two generator bodies
    // are scanned and every failure literal in them must carry a kind. Scoped to
    // those bodies deliberately: `requireDirectApiModel` below returns a
    // different type (`DirectModelResult`) that has no kind and needs none.
    const gen = readFileSync(join(process.cwd(), "lib", "llm", "generate.server.ts"), "utf8");
    const start = gen.indexOf("async function generateDirect");
    const end = gen.indexOf("// ─── direct-model gate");
    expect(start, "generateDirect not found").toBeGreaterThan(0);
    expect(end, "direct-model gate marker not found").toBeGreaterThan(start);
    const bodies = gen.slice(start, end);

    // `ok: false,` is the VALUE form; the type declarations use `ok: false;`.
    const failures = bodies.match(/ok:\s*false,/g) ?? [];
    const kinds =
      bodies.match(
        /\bkind:\s*"(unreachable|misconfigured|call_failed|unparseable|invalid_shape)"/g,
      ) ?? [];
    expect(failures.length).toBeGreaterThan(3);
    expect(kinds.length, "a failure branch returns no `kind`").toBe(failures.length);

    // And the one that matters most is the one the incident was: a reply that
    // arrived and could not be read must NOT be classified as unreachable.
    expect(bodies).toMatch(/no readable JSON[\s\S]{0,120}kind: "unparseable"/);
  });

  it("an unparseable reply is LOGGED, since the copy cannot carry it", () => {
    // The whole cause of this failure is a string nobody kept. Without this the
    // only record of a 3,270-char reply that would not parse is that it did not
    // parse.
    const gen = readFileSync(join(process.cwd(), "lib", "llm", "generate.server.ts"), "utf8");
    expect(gen).toMatch(/console\.warn\([\s\S]{0,400}no parseable JSON/);
    // The length is reported separately, so a truncated log still says how much
    // there was.
    expect(gen).toMatch(/text\.length/);
  });
});
