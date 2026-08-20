// Phase 2.5++ / G6 — role-chain smoke acceptance script.
//
// What this proves
// ────────────────
// The combination of (a) the F2 prompt hardening in
// `lib/engine/ticket-role-classifier.ts::classifyNextRole` (concrete per-role
// counts + HARD RULES + verifier-after-QA + no-PM-after-first) and (b) the
// dispatcher loop-guard in `lib/engine/dispatcher.ts::decideNextRole` (refuse
// to honour an F2 pick that resurrects a role with >=2 prior comments and no
// QA-reject retry signal) actually picks a SPECIALIST on the first dispatch
// for two specialist-flavoured tickets, instead of the generic engineer or
// the one-shot PM. The first-role pick is the load-bearing signal.
//
// COST WARNING — READ BEFORE RUNNING
// ──────────────────────────────────
// The dispatcher will spawn REAL agent runs. Each scenario triggers at least
// one classifier call (~$0.001) PLUS at least one full agent run (Sonnet/Opus
// via the local Claude Code runner or API runner). Expected per-scenario
// cost: ~$0.50–$2 depending on runner kind and how far the chain advances
// before we cut polling at 5 min or the first-role signal. With 2 scenarios
// budget roughly $1–$4 total. Self-cleans even on failure (deletes ticket +
// cascades runs + comments via the FK constraints).
//
// Pre-reqs
// ────────
// • NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY in apps/web/.env.local.
// • DEVPILOT_RUNNER_TENANT_ID set in apps/web/.env.local.
// • Next dev :3000 running, Inngest dev :8288 running.
// • Either the local apps/runner OR an API runner configured for the tenant.
//
// Exit codes:
//   0 = both scenarios picked a specialist on first dispatch
//   1 = at least one scenario picked pm/engineer (or no agent comment landed)
//   2 = environment/setup not satisfied
//
// Run:
//   cd apps/web
//   node --env-file=.env.local scripts/role-chain-smoke.mjs

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const TENANT_ID = process.env.DEVPILOT_RUNNER_TENANT_ID;
const INNGEST_DEV = process.env.INNGEST_DEV_URL ?? "http://localhost:8288";

// The task brief calls out `http://localhost:8288/e/dev_key_for_local`, but
// every other acceptance script in this repo uses `/e/dev` against the same
// Inngest dev server. We honour an INNGEST_DEV_KEY override for environments
// where the dev key has been customised.
const INNGEST_DEV_KEY = process.env.INNGEST_DEV_KEY ?? "dev";
const INNGEST_EVENT_URL = `${INNGEST_DEV}/e/${INNGEST_DEV_KEY}`;

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ITERATIONS = 100; // 100 × 3s = 5 min
const TIMEOUT_MS = POLL_INTERVAL_MS * POLL_MAX_ITERATIONS;

if (!SUPABASE_URL || !SECRET || !TENANT_ID) {
  console.error(
    "missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY / DEVPILOT_RUNNER_TENANT_ID in env — exit 2",
  );
  process.exit(2);
}

const sb = (path, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });

async function sendEvent(name, data) {
  const res = await fetch(INNGEST_EVENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) {
    throw new Error(`event send ${name} failed: ${res.status} ${await res.text()}`);
  }
}

async function getTicket(id) {
  const r = await sb(`tickets?id=eq.${id}&select=*`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function getAgentComments(id) {
  const r = await sb(
    `comments?ticket_id=eq.${id}&author_type=eq.agent&select=author_id,body,created_at&order=created_at.asc`,
  );
  return r.json();
}

const SCENARIOS = [
  {
    label: "spike",
    title: "Spike: benchmark sqlite-vec ANN throughput",
    description:
      "Run benchmarks on sqlite-vec vs faiss for ANN search; report latency p99 and recall.",
  },
  {
    label: "security",
    title: "Audit auth callback for token leakage",
    description:
      "Review /auth/callback for token-in-URL or token-in-Referer leak vectors. Add a redirect-allowlist + tests.",
  },
];

const TERMINAL_TICKET_STATES = new Set(["done", "failed", "input_required"]);

async function cleanup(ticketId) {
  try {
    // Delete comments first (no cascade on comments → tickets in current schema).
    await sb(`comments?ticket_id=eq.${ticketId}`, { method: "DELETE" });
    // Delete runs explicitly (FK to tickets has ON DELETE CASCADE in some
    // migrations, but be defensive — the script must self-clean).
    await sb(`runs?ticket_id=eq.${ticketId}`, { method: "DELETE" });
    await sb(`tickets?id=eq.${ticketId}`, { method: "DELETE" });
  } catch (err) {
    console.warn(`  cleanup for ${ticketId} hit: ${err?.message ?? err}`);
  }
}

async function runScenario({ label, title, description }) {
  const ticketId = randomUUID();
  console.log(`\n--- scenario=${label} ticket=${ticketId} ---`);
  console.log(`  title: ${title}`);

  let firstRole = null;
  const chain = [];
  const seenCommentIds = new Set();

  try {
    // 1. Insert the ticket directly in `ready` so the dispatcher can pick
    //    it up without an extra status hop. `requested_role` is null so the
    //    first-dispatch classifier runs (and writes the slug there before
    //    the dispatcher honours it on the next pass).
    const ins = await sb("tickets", {
      method: "POST",
      body: JSON.stringify({
        id: ticketId,
        tenant_id: TENANT_ID,
        title,
        description,
        status: "ready",
      }),
    });
    if (!ins.ok) {
      throw new Error(`insert failed: ${ins.status} ${await ins.text()}`);
    }

    // 2. Kick the dispatcher.
    await sendEvent("ticket/dispatch-needed", {
      ticketId,
      tenantId: TENANT_ID,
    });

    // 3. Poll comments + ticket status. Stop on (a) terminal status, (b)
    //    timeout, or (c) at least one agent comment landed (so we can
    //    capture the first-role pick — the load-bearing signal).
    const start = Date.now();
    for (let i = 0; i < POLL_MAX_ITERATIONS; i += 1) {
      const [ticket, comments] = await Promise.all([
        getTicket(ticketId),
        getAgentComments(ticketId),
      ]);
      if (!ticket) {
        throw new Error("ticket vanished during polling");
      }

      // Log new agent comments as they appear.
      for (const c of comments) {
        const key = `${c.created_at}:${c.author_id}`;
        if (seenCommentIds.has(key)) continue;
        seenCommentIds.add(key);
        const role = String(c.author_id ?? "").toLowerCase();
        if (firstRole === null) firstRole = role;
        chain.push(role);
        const excerpt = String(c.body ?? "")
          .replace(/\s+/g, " ")
          .slice(0, 120);
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`  [${role}] (t+${elapsed}s) ${excerpt}`);
      }

      const terminal = TERMINAL_TICKET_STATES.has(String(ticket.status));
      if (terminal) {
        console.log(`  → terminal status=${ticket.status}`);
        break;
      }
      if (firstRole !== null && Date.now() - start > 60_000) {
        // We've captured the first-role signal AND polled for >60s — the
        // first dispatch has fully landed. Cut polling early to save cost.
        // (60s is well above typical first-comment latency; we just don't
        // want to cut so fast that the role-post step is still in flight.)
        console.log(`  → first-role captured (${firstRole}); cutting polling early to save cost`);
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (Date.now() - start >= TIMEOUT_MS) {
      console.log(`  → timeout after ${Math.round(TIMEOUT_MS / 1000)}s`);
    }

    const specialistPicked = firstRole !== null && firstRole !== "pm" && firstRole !== "engineer";
    console.log(
      `  Ticket: ${title} — Chain: <${chain.join(" → ") || "(none)"}> — ` +
        `First role: ${firstRole ?? "(none)"} — ` +
        `Specialist picked: ${specialistPicked ? "yes" : "no"}`,
    );
    return { label, title, firstRole, chain, specialistPicked };
  } finally {
    await cleanup(ticketId);
  }
}

(async () => {
  console.log("=== G6 role-chain smoke ===");
  console.log(
    `  tenant=${TENANT_ID} inngest=${INNGEST_EVENT_URL}\n  cost warning: ~$0.50–$2 per scenario × ${SCENARIOS.length} = ~$1–$4 total\n`,
  );

  const results = [];
  for (const s of SCENARIOS) {
    try {
      results.push(await runScenario(s));
    } catch (err) {
      console.error(`  scenario=${s.label} threw: ${err?.message ?? err}`);
      results.push({
        label: s.label,
        title: s.title,
        firstRole: null,
        chain: [],
        specialistPicked: false,
        error: String(err?.message ?? err),
      });
    }
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    const mark = r.specialistPicked ? "PASS" : "FAIL";
    console.log(
      `  [${mark}] ${r.label}: first=${r.firstRole ?? "(none)"} chain=<${r.chain.join(" → ") || "(none)"}>`,
    );
  }

  const passes = results.filter(
    (s) => s.firstRole && s.firstRole !== "pm" && s.firstRole !== "engineer",
  ).length;
  console.log(`\n${passes}/${results.length} scenarios picked a specialist on first dispatch.`);
  process.exit(passes === results.length ? 0 : 1);
})();
