// Filling `apps/web/.env.local` from `.env.example` — the pure half of
// `scripts/setup-local.mjs`.
//
// The template IS the documentation (every variable sits under its own comment
// block), so the bootstrap keeps it intact and fills values IN PLACE rather than
// appending a flat list the way the in-app writer (`lib/setup/env-file.ts`)
// does. The one rule that makes re-running safe:
//
//   A VALUE THAT IS ALREADY SET IS NEVER TOUCHED.
//
// `setup:local` therefore cannot clobber a hand-edited file, cannot rotate a
// secret the runner is already registered with, and is idempotent by
// construction — the second run reports every key as `kept` and writes the
// same bytes. The only override path is blanking the line and re-running,
// which is a deliberate act the operator can see in a diff.
//
// Per key, in order of preference:
//   kept        — an active `KEY=value` line with a non-blank value exists
//   set         — an active `KEY=` line exists and is blank: the value goes there
//   uncommented — only a `# KEY=…` line exists (the template ships some vars
//                 commented out, e.g. `# INNGEST_DEV=1`): it becomes active
//   appended    — the key appears nowhere: added once under SETUP_BANNER
//
// Both loaders this file serves (@next/env and `node --env-file`) are
// last-occurrence-wins, so "the active line" means the LAST active line for
// that key — the one that actually takes effect.

import { serializeEnvValue } from "../setup/env-value";

export type EnvFillAction = "set" | "kept" | "uncommented" | "appended";
export type EnvFillReport = ReadonlyArray<{ key: string; action: EnvFillAction }>;

export const SETUP_BANNER = "# ── Added by pnpm setup:local ──";

const ACTIVE_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/;
const COMMENTED_LINE = /^\s*#\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/;

/** Decode the right-hand side of a dotenv line the way the loaders do:
 *  double-quoted (with `\"` and `\\` escapes), single-quoted (raw), or bare
 *  (trimmed, with a trailing ` # comment` dropped). */
function decodeValue(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  return v.replace(/\s+#.*$/, "").trim();
}

/** Parse dotenv content into a map. Comments and blank lines are skipped,
 *  `export KEY=` is accepted, and a repeated key resolves to its LAST value —
 *  the semantics shared by @next/env and `node --env-file`. */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const m = ACTIVE_LINE.exec(line);
    if (!m) continue;
    out[m[1] ?? ""] = decodeValue(m[2] ?? "");
  }
  return out;
}

/** The keys of `required` whose value is absent or blank in `env`. */
export function missingKeys(
  env: Record<string, string | undefined>,
  required: readonly string[],
): string[] {
  return required.filter((k) => (env[k] ?? "").trim().length === 0);
}

/**
 * Fill `values` into `content` under the rules in the header. Returns the new
 * content (always newline-terminated) and a per-key report in `values` order.
 * Throws on a value `serializeEnvValue` refuses — nothing is partially applied.
 */
export function fillEnvTemplate(
  content: string,
  values: Record<string, string>,
): { content: string; report: EnvFillReport } {
  const lines = content.split("\n");
  // Drop the empty element a trailing newline produces so appends land on a
  // real last line; the terminator is restored on output.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const serialized = new Map(Object.entries(values).map(([k, v]) => [k, serializeEnvValue(v)]));
  const report: { key: string; action: EnvFillAction }[] = [];
  const toAppend: string[] = [];

  for (const [key, value] of serialized) {
    let lastActive = -1;
    let firstCommented = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const active = ACTIVE_LINE.exec(line);
      if (active?.[1] === key) {
        lastActive = i;
        continue;
      }
      if (firstCommented === -1) {
        const commented = COMMENTED_LINE.exec(line);
        if (commented?.[1] === key) firstCommented = i;
      }
    }

    if (lastActive !== -1) {
      const current = decodeValue(ACTIVE_LINE.exec(lines[lastActive] ?? "")?.[2] ?? "");
      if (current.length > 0) {
        report.push({ key, action: "kept" });
      } else {
        lines[lastActive] = `${key}=${value}`;
        report.push({ key, action: "set" });
      }
      continue;
    }
    if (firstCommented !== -1) {
      lines[firstCommented] = `${key}=${value}`;
      report.push({ key, action: "uncommented" });
      continue;
    }
    toAppend.push(`${key}=${value}`);
    report.push({ key, action: "appended" });
  }

  if (toAppend.length > 0) {
    if (!lines.includes(SETUP_BANNER)) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(SETUP_BANNER);
    }
    lines.push(...toAppend);
  }

  return { content: `${lines.join("\n")}\n`, report };
}
