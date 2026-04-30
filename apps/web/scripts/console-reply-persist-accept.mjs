// Acceptance for the two supervisor-console defects of 2026-08-04.
//
//   pnpm --filter @devpilot/web accept:console-reply-persist
//
// ── WHY THIS EXISTS RATHER THAN MORE UNIT TESTS ───────────────────────────
// Both defects lived in files no unit test can load. `generate.server.ts`,
// `console-answer.server.ts` and `console-history-store.server.ts` all reach
// `server-only`; `console-server-actions.ts` reaches `next/headers`. The unit
// suites cover the pure rules - the extractor, the retry budget, the link
// decision, the copy - and every one of them was GREEN while the console was
// throwing away a good answer, because what was broken was the ORDER those
// rules sat in and the wiring between them.
//
// So this drives the real modules, against the real local Supabase and the real
// Redis queue, with a STUB RUNNER standing in for `claude -p`.
//
// ── WHY A STUB RUNNER AND NOT THE REAL ONE ────────────────────────────────
// The half of this that has to be proved is what happens to a reply of a GIVEN
// SHAPE - prose that hides an object, prose that hides nothing, prose on the
// first attempt and JSON on the second. A real `claude -p` cannot be asked for
// any of those on demand: it is non-deterministic, and the "genuinely
// unparseable" case is precisely the one it will not reliably produce. The stub
// replaces exactly one thing - the text the model returns - and every other hop
// is the production one: the synthetic `runs` row, the Redis LPUSH, the result
// envelope the step-result route writes, the poll, the extractor, the schema,
// the grounding, the transcript and the ledger.
//
// LOCAL DATABASE ONLY. It writes a fixture project and deletes it again;
// pointing it at a cloud Supabase is refused up front.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import http from "node:http";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "";

// ── The two-key refusal, the `guide-capture.mjs` shape. A cloud run would
//    write a fixture project into somebody's real workspace. Parsed, never
//    prefix-matched: `https://localhost.evil.example` starts with the right
//    characters.
function assertLocal() {
  let host;
  try {
    host = new URL(SUPABASE_URL).hostname;
  } catch {
    throw new Error(`NEXT_PUBLIC_SUPABASE_URL is not a URL: ${SUPABASE_URL}`);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `refusing to run against a non-local Supabase (${host}). This script writes a fixture ` +
        `project and deletes it; point it at your local stack.`,
    );
  }
  if (!SERVICE_KEY) {
    throw new Error("missing SUPABASE service key — run with --env-file=.env.local");
  }
}

// ── A LOCAL, IN-MEMORY UPSTASH ──────────────────────────────────────────────
//
// Deliberately NOT the configured Upstash instance, for two reasons that both
// have to hold: a shared Upstash would put this script's stub runner on the
// same `devpilot:jobs:local-cc:ready` list a REAL runner drains, so it could pop
// a genuine agent job and answer it with a fixture; and a free-tier instance
// that has since been deleted (which is what this worktree had) makes the whole
// proof unrunnable for reasons unrelated to the code.
//
// It speaks the exact wire protocol `@upstash/redis` emits - `POST /pipeline`
// with `[[cmd, ...args], ...]`, answering `[{result}, ...]` - so the client, the
// `{text}` envelope, the key layout and the poll loop under test are all the
// production ones. Only the storage is swapped.
const store = new Map();

function runCommand(cmd) {
  const [op, ...a] = cmd;
  switch (String(op).toLowerCase()) {
    case "lpush": {
      const list = store.get(a[0]) ?? [];
      list.unshift(...a.slice(1));
      store.set(a[0], list);
      return list.length;
    }
    case "rpop": {
      const list = store.get(a[0]);
      if (!Array.isArray(list) || list.length === 0) return null;
      return list.pop();
    }
    case "lrem": {
      const list = store.get(a[0]);
      if (!Array.isArray(list)) return 0;
      const i = list.indexOf(a[2]);
      if (i < 0) return 0;
      list.splice(i, 1);
      return 1;
    }
    // `get` returns the STORED STRING, exactly as Upstash does. Returning a
    // pre-parsed object here reads as harmless and is not: `@upstash/redis`
    // does its OWN deserialisation of the result and hands back `null` for one
    // it did not parse itself, so the poll loop would spin until its 180s
    // ceiling and report a timeout - which is what the first run of this script
    // did. A protocol shim that is "nearly" the protocol is worse than none.
    case "get": {
      const v = store.get(a[0]);
      return v === undefined ? null : v;
    }
    case "set":
      store.set(a[0], a[1]);
      return "OK";
    case "del":
      return store.delete(a[0]) ? 1 : 0;
    case "ping":
      return "PONG";
    default:
      throw new Error(`stub redis: unsupported command ${op}`);
  }
}

async function startRedisShim() {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let out;
      try {
        const parsed = JSON.parse(body || "[]");
        const cmds = Array.isArray(parsed[0]) ? parsed : [parsed];
        out = cmds.map((c) => ({ result: runCommand(c) }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(e) }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  // Set BEFORE any console module is imported: `lib/cache/redis.ts` resolves
  // and memoizes its client lazily on first use, and `lib/env` reads at import.
  process.env.UPSTASH_REDIS_REST_URL = url;
  process.env.UPSTASH_REDIS_REST_TOKEN = "stub";
  return { url, close: () => new Promise((r) => srv.close(r)) };
}

/** The stub runner's own access, through the same shim. */
async function redis(cmd) {
  const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([cmd]),
  });
  if (!res.ok) throw new Error(`stub redis ${res.status}`);
  return (await res.json())[0].result;
}

const QUEUE = "devpilot:jobs:local-cc:ready";

/**
 * Stand in for the runner for ONE call.
 *
 * Pops the job, hands back `replyFor(attemptIndex, job)`, and writes it into the
 * exact envelope `/api/runs/[id]/step-result` writes: `{text}` under
 * `devpilot:run-result:<runId>`. Returns every job it saw, so a caller can assert
 * that the retry FIRED and what the retry prompt said - the thing no unit test
 * can see.
 */
function startStubRunner(replyFor) {
  const seen = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const raw = await redis(["RPOP", QUEUE]).catch(() => null);
      if (!raw) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      const job = JSON.parse(raw);
      seen.push(job);
      const text = replyFor(seen.length - 1, job);
      await redis(["SET", `devpilot:run-result:${job.runId}`, JSON.stringify({ text })]);
    }
  })();
  return {
    seen,
    async stop() {
      stop = true;
      await loop;
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const db = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function seed(sb) {
  const { data: tenant } = await sb.from("tenants").select("id").limit(1).maybeSingle();
  if (!tenant) throw new Error("no tenant in the local database - run the app's setup first");
  const tenantId = tenant.id;
  const projectId = randomUUID();
  const { error: pErr } = await sb.from("projects").insert({
    id: projectId,
    tenant_id: tenantId,
    name: `console-accept-${projectId.slice(0, 8)}`,
    // ACT is gated on this; EXPLAIN is not. The command half of the proof
    // needs it on.
    supervisor_enabled: true,
  });
  if (pErr) throw new Error(`seed project: ${pErr.message}`);

  // One ticket the console can see and talk about. Deliberately `in_progress`
  // with no run, which is the shape the operator's real question was about.
  const ticketId = randomUUID();
  const { error: tErr } = await sb.from("tickets").insert({
    id: ticketId,
    tenant_id: tenantId,
    project_id: projectId,
    title: "Spike: architecture & integration contract",
    status: "in_progress",
    requested_role: "engineer",
    column_position: 1024,
  });
  if (tErr) throw new Error(`seed ticket: ${tErr.message}`);

  const { data: t } = await sb
    .from("tickets")
    .select("ticket_number")
    .eq("id", ticketId)
    .maybeSingle();

  // A runner heartbeat, because `generateObjectForTenant` pre-checks liveness
  // before it will enqueue anything at all.
  const runnerId = randomUUID();
  await sb.from("runners").insert({
    id: runnerId,
    tenant_id: tenantId,
    kind: "local-cc",
    name: "console-accept-stub",
    status: "online",
    last_heartbeat_at: new Date().toISOString(),
  });

  // Kept fresh for the length of the run: `deriveRunnerHealth` ages a runner
  // out, and a stale row makes every later phase report "your runner isn't
  // connected" instead of exercising the reply path.
  const beat = setInterval(() => {
    void sb
      .from("runners")
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq("id", runnerId);
  }, 5_000);
  beat.unref?.();

  return {
    tenantId,
    projectId,
    ticketId,
    ticketKey: `DevPilot-${t?.ticket_number}`,
    runnerId,
    beat,
  };
}

async function cleanup(sb, f) {
  if (!f) return;
  clearInterval(f.beat);
  await sb.from("runners").delete().eq("id", f.runnerId);
  await sb.from("supervisor_actions").delete().eq("project_id", f.projectId);
  await sb.from("supervisor_console_messages").delete().eq("project_id", f.projectId);
  await sb.from("runs").delete().eq("tenant_id", f.tenantId).is("ticket_id", null);
  await sb.from("tickets").delete().eq("project_id", f.projectId);
  await sb.from("projects").delete().eq("id", f.projectId);
}

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── The replies. These are the SHAPES, not inventions: #1 is the live
//    2026-08-04 reply's opening, verbatim from the server log.
const LIVE_PROSE =
  "Captain, the honest answer is: none of them are confirmed working correctly right now — " +
  "DevPilot-1 is the only one active, and its record is mixed at best.\n\n" +
  '**DevPilot-1** ("Spike: architecture & integration contract") is the sole ticket the machine ' +
  "is touching. It's `in_progress`, its run finished `done` 1 minute ago, and the automatic " +
  'recovery check stood down because it sees a completed run — that\'s why it shows "settling".';

async function main() {
  assertLocal();
  const shim = await startRedisShim();
  console.log(`stub redis at ${shim.url}`);
  const sb = db();
  let fixture = null;
  try {
    fixture = await seed(sb);
    console.log(`fixture project ${fixture.projectId} (${fixture.ticketKey})\n`);

    const { answerConsoleQuestion } = await import("../lib/supervisor/console-answer.server.ts");
    const { loadConsoleSnapshot } = await import("../lib/supervisor/console-store.ts");
    const { defaultConsoleDeps } = await import("../lib/supervisor/console-store.server.ts");
    const { appendConsoleMessage, loadConsoleThread, loadConsoleMessageById } =
      await import("../lib/supervisor/console-history-store.ts");
    const { defaultConsoleHistoryDeps } =
      await import("../lib/supervisor/console-history-store.server.ts");
    const { decideConsoleMessageLink, toModelContextTurns } =
      await import("../lib/supervisor/console-history.ts");
    const { describeConsoleModelFailure } = await import("../lib/supervisor/console-view.ts");
    const { recordConsoleAction } = await import("../lib/supervisor/console-store.ts");

    const nowIso = new Date().toISOString();
    const hDeps = defaultConsoleHistoryDeps();
    const loaded = await loadConsoleSnapshot(defaultConsoleDeps(nowIso), {
      tenantId: fixture.tenantId,
      projectId: fixture.projectId,
    });
    if (!loaded.ok) throw new Error(`snapshot: ${loaded.error}`);
    const { snapshot, actions } = loaded.result;
    const ask = (question, history = []) =>
      answerConsoleQuestion({
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        snapshot,
        actions,
        commands: [],
        question,
        history,
      });

    // ─────────────────────────────────────────────────────────────────────
    console.log("1. THE DEFECT: a prose-led reply that hides its object");
    // Narrative first, the object at the end. THE PROSE CONTAINS A BRACE, and
    // that is the whole point of the fixture rather than decoration: the old
    // extractor took ONE span from the first `{` to the last `}`, so a brace in
    // the prose swallowed the object into an unparseable blob. Prose with no
    // brace at all is NOT a discriminating fixture - the first version of this
    // check was that, and it stayed green against the pre-fix extractor.
    // A console answer quoting a status object is entirely ordinary.
    {
      const prose =
        LIVE_PROSE +
        "\n\nIts last recorded outcome was `{ recovered: false }`, which is not a verdict.";
      const stub = startStubRunner(
        () =>
          prose +
          "\n\nHere is the structured form:\n" +
          JSON.stringify({
            answer: prose,
            aboutTickets: [fixture.ticketKey],
            outOfScope: false,
          }),
      );
      const res = await ask("what ticket is it working on correctly?");
      await stub.stop();
      check("the answer is returned, not discarded", res.ok, res.ok ? "" : res.error);
      check(
        "it is the model's own answer",
        res.ok && res.reply.answer.includes("DevPilot-1 is the only one active"),
      );
      check(
        "the ticket it named is grounded and linked",
        res.ok && res.reply.aboutTickets.includes(fixture.ticketKey),
        res.ok ? JSON.stringify(res.reply.aboutTickets) : "",
      );
      check("exactly one model call - no retry was needed", stub.seen.length === 1);
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log("\n2. THE RETRY: pure prose first, JSON when asked again");
    {
      const stub = startStubRunner((attempt) =>
        attempt === 0
          ? LIVE_PROSE
          : JSON.stringify({ answer: "DevPilot-1 is the only active ticket.", outOfScope: false }),
      );
      const res = await ask("why is nothing moving?");
      await stub.stop();
      check("the second attempt is accepted", res.ok, res.ok ? "" : res.error);
      check("exactly two model calls", stub.seen.length === 2, `saw ${stub.seen.length}`);
      const retryPrompt = stub.seen[1]?.prompt ?? "";
      check("the retry says the last reply was not JSON", /was not JSON/i.test(retryPrompt));
      check(
        "the retry quotes what the model sent",
        retryPrompt.includes("Captain, the honest answer is"),
      );
      check(
        "the retry re-states the original question",
        retryPrompt.includes("why is nothing moving?"),
      );
      check(
        "the system prompt says where a narrative goes",
        /inside/i.test(stub.seen[0]?.systemPrompt ?? "") &&
          /narrative|prose|explanation/i.test(stub.seen[0]?.systemPrompt ?? ""),
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log("\n3. STILL HONEST: a reply that genuinely cannot be parsed");
    {
      const stub = startStubRunner(() => LIVE_PROSE);
      const res = await ask("what is the state of the board?");
      await stub.stop();
      check("it fails", !res.ok);
      check("two attempts were made before giving up", stub.seen.length === 2);
      check(
        "it is classified as unparseable, not unreachable",
        !res.ok && res.kind === "unparseable",
      );
      // THE PART THAT WAS MISSING. The operator saw a parse error and not one
      // word of a good answer.
      check(
        "the model's own reply is carried out",
        !res.ok && (res.rawReply ?? "").includes("DevPilot-1 is the only one active"),
      );
      const shown = describeConsoleModelFailure(res.kind, res.error, res.rawReply);
      check(
        "and it reaches the operator's screen",
        shown.includes("DevPilot-1 is the only one active"),
      );
      check("labelled unverified", /unverified/i.test(shown));
      check("not blamed on the connection", !/could not reach/i.test(shown));
      console.log("\n      ── what the operator now sees ──");
      console.log(
        shown
          .split("\n")
          .slice(0, 12)
          .map((l) => `      ${l}`)
          .join("\n"),
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log("\n4. THE CONVERSATION IS SAVED, AND RELOADS");
    let askedId = null;
    {
      const before = await loadConsoleThread(hDeps, {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
      });
      check("a fresh board has an empty thread", before.length === 0);

      const q = `unstick ${fixture.ticketKey} please`;
      const a = await appendConsoleMessage(hDeps, {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        role: "operator",
        kind: "ask",
        body: q,
      });
      check("the operator's message is stored", a.ok, a.ok ? a.id : "");
      askedId = a.ok ? a.id : null;
      await appendConsoleMessage(hDeps, {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        role: "console",
        kind: "answer",
        body: "It is in progress with no live run.",
      });

      // A SECOND read, exactly as a page reload performs it.
      const after = await loadConsoleThread(hDeps, {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
      });
      check("the thread comes back", after.length === 2, `${after.length} turn(s)`);
      check("oldest first", after[0]?.role === "operator" && after[1]?.role === "console");
      check("with the text intact", after[0]?.body === q);

      // And it is what the NEXT question replays into the model.
      const stub = startStubRunner((_a, job) => {
        return JSON.stringify({ answer: `saw:${/unstick/.test(job.prompt)}`, outOfScope: false });
      });
      const res = await ask("and now?", toModelContextTurns(after));
      await stub.stop();
      check(
        "the stored thread reaches the model's prompt",
        res.ok && res.reply.answer === "saw:true",
      );
      check("and it is fenced as untrusted", /UNTRUSTED/.test(stub.seen[0]?.prompt ?? ""));
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log("\n5. A COMMANDED FIX IS TRACEABLE TO ITS MESSAGE");
    {
      const q = `unstick ${fixture.ticketKey} please`;
      const msg = await loadConsoleMessageById(hDeps, {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        messageId: askedId,
      });
      const link = decideConsoleMessageLink({ messageId: askedId, message: msg, question: q });
      check("the link is proven from the stored message", link.link === true);

      await recordConsoleAction(defaultConsoleDeps(new Date().toISOString()), {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        ticketId: fixture.ticketId,
        cause: "stalled_ticket",
        action: "operator:recover_ticket",
        detail: "acceptance run",
        consoleMessageId: link.link ? link.messageId : null,
      });

      // The join an operator actually needs: from a fix, back to what was asked.
      const { data: rows } = await sb
        .from("supervisor_actions")
        .select("action, cause, console_message_id, supervisor_console_messages(body, role)")
        .eq("project_id", fixture.projectId);
      const row = (rows ?? [])[0];
      check("the ledger row exists", Boolean(row));
      check("it points at the message", row?.console_message_id === askedId);
      check(
        "and the join answers 'what did they ask?'",
        row?.supervisor_console_messages?.body === q,
        row?.supervisor_console_messages?.body ?? "(no join)",
      );
      // The cause is still the AUTONOMOUS one - splitting it would stop the
      // repeat-defect detector seeing the sweeps a human performs.
      check("the cause is shared with the autonomous supervisor", row?.cause === "stalled_ticket");

      // A mismatched id is REFUSED rather than recorded as a plausible lie.
      const bad = decideConsoleMessageLink({
        messageId: askedId,
        message: msg,
        question: "close something else entirely",
      });
      check("a message that says something else is not linked", bad.link === false);
      check("and the reason is named", bad.link === false && bad.reason === "text-mismatch");
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log("\n6. TENANT SCOPE, AGAINST THE REAL DATABASE");
    {
      const { data: other } = await sb
        .from("tenants")
        .select("id")
        .neq("id", fixture.tenantId)
        .limit(1)
        .maybeSingle();
      if (!other) {
        console.log("  skip  only one tenant in this database");
      } else {
        const asOther = await loadConsoleThread(hDeps, {
          tenantId: other.id,
          projectId: fixture.projectId,
        });
        check("another tenant cannot read this conversation", asOther.length === 0);
        const m = await loadConsoleMessageById(hDeps, {
          tenantId: other.id,
          projectId: fixture.projectId,
          messageId: askedId,
        });
        check("nor resolve one of its messages for an audit link", m === null);
      }
    }
  } finally {
    await cleanup(sb, fixture);
    await shim.close();
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
