#!/usr/bin/env node
// Guardrail for the ACE -> DevPilot rename: fail if a NEW `ace` brand token appears in a
// namespace that has already been fully migrated.
//
// This gate is deliberately TARGETED, not a blanket `\bace\b` sweep. Several `ace` tokens
// are retained on purpose (an issued API key's vendor tag is inside its sha256 preimage; a
// pre-rename git branch, HTTP header, env var or localStorage key must still be readable),
// and a blanket gate would need a line-level exclude list that rots on every edit. Instead
// we check only the namespaces where the rename is COMPLETE, so any reappearance is a
// regression by definition:
//
//   1. `ace_<tool>` — the 10 MCP tool names, which are also `comments.author_id` values.
//   2. `ace-board`  — the MCP server key / model-visible `mcp__ace-board__*` namespace.
//   3. `"ace:…"`    — the Redis key namespace.
//   4. `"ace-engine"` — the Inngest app id.
//   5. `process.env.ACE_*` / `env.ACE_*` — env reads outside the legacy-alias shims.
//
// The retained namespaces (vendor tag, `ace/` branch prefix, `x-ace-*` headers, `ACE_*`
// alias-shim tables, `ace:`/`ace-` localStorage read-through, supabase/config.toml's
// project_id, applied migrations) are excluded by path below. Adding a legitimate new
// legacy-compat site means adding it here, consciously.
//
// Run: node scripts/check-legacy-brand.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Files whose `ace` tokens are retained by design, each with the reason beside it. */
const ALLOWED_PATHS = new Set([
  // The API key vendor tag `ace_<prefix>_<secret>` is inside the sha256 preimage of every
  // issued key. Changing it kills those keys with no possible migration.
  "apps/web/lib/api/key-auth.ts",
  "apps/web/lib/api/__tests__/key-auth.test.ts",
  "apps/web/app/(app)/settings/api-keys/key-list.tsx",
  "apps/web/scripts/phase1-m14-accept.mjs",
  "apps/web/tests/widget-integration.html",
  "apps/web/app/v1/agents/[id]/runs/route.ts",
  "apps/web/app/api/widget/run/route.ts",
  // Legacy env-var alias shims (the only place an `ACE_*` name may still be written).
  "apps/web/lib/env/legacy-alias.ts",
  "apps/web/lib/env/__tests__/legacy-alias.test.ts",
  "apps/runner/src/legacy-alias.ts",
  // Pre-rename cookie / localStorage keys, read-through only. The `ace:*` browser-storage
  // namespace is spelled the same way as the (migrated) `ace:*` Redis namespace, so these
  // few components are excluded by path rather than by weakening the Redis rule — that one
  // guards a cross-process queue whose failure mode is silent.
  "apps/web/lib/projects/current.ts",
  "apps/web/lib/storage/legacy-key.ts",
  "apps/web/lib/storage/__tests__/legacy-key.test.ts",
  "apps/web/components/board/FirstDispatchNudge.tsx",
  "apps/web/components/runs/TraceCoachMark.tsx",
  "apps/web/components/shell/readiness-checklist.tsx",
  // Pre-rename Stripe meter / idempotency-key names, referenced in comments only.
  "apps/web/lib/billing/meter.ts",
  "apps/web/lib/billing/stripe.ts",
  // This gate itself names every pattern it forbids.
  "scripts/check-legacy-brand.mjs",
]);

/** Directories whose contents are historical records or out of scope. */
const ALLOWED_PREFIXES = [
  "supabase/migrations/", // applied migrations are immutable history
  "docs/", // narrative docs may name the pre-rename identifiers
];

/** Files where the `ace` token is not the brand at all, or is an intentional prose mention. */
const ALLOWED_EXACT = new Set([
  "supabase/config.toml", // project_id keys the local Docker volumes — changing it = data loss
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
]);

const TOOL_NAMES = [
  "move_ticket",
  "comment",
  "handoff",
  "create_ticket",
  "spawn_agent",
  "request_human",
  "request_secret",
  "query_db",
  "query_db_smart",
  "log_conflict_event",
  "run_command",
];

const RULES = [
  {
    id: "mcp-tool-name",
    re: new RegExp(`(?<![A-Za-z0-9])ace_(?:${TOOL_NAMES.join("|")})(?![a-z_])`),
    why: "MCP tool names (and the comments.author_id values they stamp) are `devpilot_*`. A DB backfill moved every stored row; reintroducing `ace_*` makes the reconciler blind to it.",
  },
  {
    id: "mcp-server-key",
    re: /(?<![A-Za-z0-9])ace-board/,
    why: "The MCP server key is `devpilot-board` (namespace `mcp__devpilot-board__*`).",
  },
  {
    id: "redis-namespace",
    re: /["'`]ace:/,
    why: "The Redis key namespace is `devpilot:*`. A stray `ace:` key means the web app and the runner stop seeing each other's queue, silently.",
  },
  {
    // Matched as an assignment (`id: "ace-engine"`), not as a bare mention: the client's
    // own comment explains why the id used to be `ace-engine`, and that comment is worth
    // keeping. A regression would be the value coming back, not the word.
    id: "inngest-app-id",
    re: /\bid\s*:\s*["'`]ace-engine["'`]/,
    why: "The Inngest app id is `devpilot-engine`.",
  },
  {
    id: "legacy-env-read",
    re: /(?:process\.)?env\.ACE_|process\.env\[\s*["'`]ACE_/,
    why: "`ACE_*` env vars are read only through the legacy-alias shim, which mirrors them onto their `DEVPILOT_*` names at boot. Read the `DEVPILOT_*` name.",
  },
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((f) => !/\.(png|jpe?g|gif|ico|woff2?|ttf|pdf)$/i.test(f))
  .filter((f) => f !== "pnpm-lock.yaml")
  .filter((f) => !ALLOWED_PATHS.has(f))
  .filter((f) => !ALLOWED_EXACT.has(f))
  .filter((f) => !ALLOWED_PREFIXES.some((p) => f.startsWith(p)));

const violations = [];
for (const file of files) {
  let lines;
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    continue; // unreadable / binary
  }
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push({ file, line: i + 1, rule, text: line.trim().slice(0, 140) });
      }
    }
  });
}

if (violations.length === 0) {
  console.log(`✓ no legacy ACE brand tokens in ${files.length} tracked files`);
  process.exit(0);
}

console.error(`✗ ${violations.length} legacy ACE brand token(s) found:\n`);
const byRule = new Map();
for (const v of violations) {
  if (!byRule.has(v.rule.id)) byRule.set(v.rule.id, []);
  byRule.get(v.rule.id).push(v);
}
for (const [id, vs] of byRule) {
  console.error(`  [${id}] ${vs[0].rule.why}`);
  for (const v of vs) console.error(`    ${v.file}:${v.line}  ${v.text}`);
  console.error("");
}
console.error(
  "If this is a deliberate legacy-compat site, add its path to ALLOWED_PATHS in scripts/check-legacy-brand.mjs\n" +
    "and record the reason beside it in this script's header.",
);
process.exit(1);
