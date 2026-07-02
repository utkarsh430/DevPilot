// Phase 1 / M11 — merge probe.
//
// Spawned by `phase1-m11-accept.mjs` to reproduce the SAME merge the
// dispatcher's `merge-skills` step.run performs, against the SAME inputs.
// Reads JSON from stdin: `{ tenantId, role, ticketText }`. Writes JSON to
// stdout: `{ merged, skills: [{id, name, body}] }`.
//
// We use this for the live-ticket assertion in T3b because the dispatcher's
// runner-bound systemPrompt only lands on the runner — and the runner may
// be offline in an acceptance run. The merge function itself is pure with
// respect to (tenant, role, ticketText), so re-running it here is a faithful
// stand-in for "read run_steps.payload.systemPrompt".

import { selectSkillsForDispatch } from "../lib/skills/select.js";
import { mergeSkillsIntoSystemPrompt } from "../lib/skills/merge.js";
import { getBuiltinRoleConfig, loadCustomRoleConfig } from "../lib/roles/load.js";

async function main() {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    tenantId: string;
    role: string;
    ticketText: string;
  };

  const base =
    getBuiltinRoleConfig(input.role) ?? (await loadCustomRoleConfig(input.tenantId, input.role));
  if (!base) {
    process.stderr.write(`no role config for "${input.role}"\n`);
    process.exit(1);
  }

  const skills = await selectSkillsForDispatch({
    tenantId: input.tenantId,
    role: input.role,
    ticketText: input.ticketText,
    enableRank: false, // offline-deterministic
  });
  const merged = mergeSkillsIntoSystemPrompt(base.systemPrompt, skills);
  process.stdout.write(
    JSON.stringify({
      merged,
      skills: skills.map((s) => ({ id: s.id, name: s.name, body: s.body })),
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`probe crashed: ${err?.message ?? err}\n`);
  process.exit(1);
});
