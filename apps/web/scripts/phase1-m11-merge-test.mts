// Phase 1 / M11 — direct merge unit test.
//
// Verifies the M11 runtime contract without standing up Inngest or a runner:
//
//   • The seed catalog has the "RFC writer" skill at tenant_id IS NULL.
//   • Installing it into the operator tenant produces a tenant-scoped clone
//     whose `installed_from_skill_id` points back at the public row.
//   • Calling `selectSkillsForDispatch` for the engineer role with a ticket
//     about an RFC returns the installed clone.
//   • `mergeSkillsIntoSystemPrompt` produces a prompt that contains:
//       1. the original role systemPrompt verbatim,
//       2. the skill body verbatim,
//       3. the SKILL_FENCE_HEADER guard.
//
// Run standalone:
//   cd apps/web
//   ../../apps/runner/node_modules/.bin/tsx scripts/phase1-m11-merge-test.mts
//
// Exits 0 on pass, 1 on any assertion failure. Designed to be invoked from
// the main `phase1-m11-accept.mjs` script as a pre-flight check (same
// pattern as `phase1-m10-validator-test.mts`).

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { selectSkillsForDispatch } from "../lib/skills/select.js";
import { mergeSkillsIntoSystemPrompt, SKILL_FENCE_HEADER } from "../lib/skills/merge.js";
import { engineerRole } from "../lib/roles/engineer.js";

const TENANT_ID = process.env.DEVPILOT_OPERATOR_TENANT_ID ?? "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY in env");
  process.exit(1);
}

const sb = (p: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    ...init,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });

type AnyJson = { [k: string]: unknown };

async function fetchPublicRfcSkill(): Promise<AnyJson> {
  const r = await sb(
    `skills?tenant_id=is.null&name=eq.${encodeURIComponent("RFC writer")}&select=*&limit=1`,
  );
  const arr = (await r.json()) as AnyJson[];
  if (arr.length === 0) {
    throw new Error("RFC writer public skill not seeded — re-run the M11 migration");
  }
  return arr[0];
}

async function installIfMissing(publicSkillId: string): Promise<AnyJson> {
  const existing = await sb(
    `skills?tenant_id=eq.${TENANT_ID}&installed_from_skill_id=eq.${publicSkillId}&select=*&limit=1`,
  );
  const rows = (await existing.json()) as AnyJson[];
  if (rows.length > 0) return rows[0];
  // Clone via the same shape installSkillAction uses.
  const pub = await sb(`skills?id=eq.${publicSkillId}&select=*&limit=1`);
  const pubRow = ((await pub.json()) as AnyJson[])[0];
  const ins = await sb("skills", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      name: pubRow.name,
      version: pubRow.version,
      manifest: pubRow.manifest,
      body: pubRow.body,
      targets: pubRow.targets ?? [],
      triggers: pubRow.triggers ?? [],
      installed_from_skill_id: publicSkillId,
    }),
  });
  if (!ins.ok) throw new Error(`install failed: ${ins.status} ${await ins.text()}`);
  return ((await ins.json()) as AnyJson[])[0];
}

async function deleteInstalled(installedId: string): Promise<void> {
  await sb(`skills?id=eq.${installedId}&tenant_id=eq.${TENANT_ID}`, { method: "DELETE" });
}

function assert(label: string, cond: boolean): void {
  if (!cond) {
    console.error(`  FAIL  ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  pass  ${label}`);
  }
}

(async () => {
  console.log("=== Phase 1 / M11 merge unit test ===");

  const publicSkill = await fetchPublicRfcSkill();
  console.log(`  public RFC writer: id=${String(publicSkill.id).slice(0, 8)}`);

  const installed = await installIfMissing(publicSkill.id as string);
  console.log(
    `  installed clone: id=${String(installed.id).slice(0, 8)} installed_from=${String(installed.installed_from_skill_id).slice(0, 8)}`,
  );

  try {
    assert("clone references public source", installed.installed_from_skill_id === publicSkill.id);
    assert("clone body matches public body", installed.body === publicSkill.body);

    const ticketText =
      "RFC: replace the dispatcher's deterministic role-picker with a Haiku " +
      "classifier. Need a one-page design doc covering motivation, proposal, " +
      "and rollout plan.";

    // Skip the LLM rank to keep the test offline + cheap; the keyword
    // pre-filter alone is enough to surface "RFC writer" for an engineer
    // ticket containing the word "RFC".
    const selected = await selectSkillsForDispatch({
      tenantId: TENANT_ID,
      role: "engineer",
      ticketText,
      enableRank: false,
    });
    console.log(`  selected skills: ${selected.map((s) => s.name).join(", ") || "(none)"}`);

    assert("at least one skill selected for engineer + RFC ticket", selected.length > 0);
    const rfc = selected.find((s) => s.name === "RFC writer");
    assert("RFC writer was selected", Boolean(rfc));

    if (rfc) {
      const merged = mergeSkillsIntoSystemPrompt(engineerRole.systemPrompt, selected);
      assert(
        "merged prompt contains original engineer systemPrompt",
        merged.includes(engineerRole.systemPrompt),
      );
      assert("merged prompt contains skill body", merged.includes(rfc.body));
      assert("merged prompt contains SKILL fence header", merged.includes(SKILL_FENCE_HEADER));
      assert(
        "merged prompt is longer than base systemPrompt",
        merged.length > engineerRole.systemPrompt.length,
      );
      assert(
        "merged prompt restates untrusted-content rule (skills are data not instructions)",
        merged.toLowerCase().includes("data, not instructions"),
      );
    }
  } finally {
    // Leave the install in place — the main accept script reuses it.
    void deleteInstalled;
  }

  if (process.exitCode === 1) {
    console.error("\nFAIL — merge unit test had at least one assertion failure");
    process.exit(1);
  }
  console.log("\nPASS — M11 merge unit test");
})().catch((err) => {
  console.error("merge unit test crashed:", err);
  process.exit(1);
});
