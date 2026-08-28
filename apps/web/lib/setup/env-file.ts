// Allowlisted, comment-preserving, atomic writer for `apps/web/.env.local` —
// the single env file of the whole stack (the runner reads it too, via
// `--env-file=../web/.env.local`). Used by the boot /setup API and the
// Settings → Setup wizard's env-backed steps.
//
// Safety posture:
//  - only keys in ENV_WRITE_ALLOWLIST can be touched (never arbitrary env),
//  - existing lines/comments/ordering are preserved; managed keys are updated
//    in place, new ones appended under one marked section,
//  - the write is atomic (temp file + rename) with 0600 perms,
//  - refuses outright on serverless hosts (VERCEL) — there is no writable env
//    file there; callers surface copy-paste instructions instead.

import "server-only";

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { serializeEnvValue } from "./env-value";

/** Env-managed configuration (design decision D4): values a process reads at
 *  boot (web init, the runner's --env-file) or that must exist before the
 *  database is reachable. Everything else belongs in the platform-secrets
 *  instance scope, not here. */
export const ENV_WRITE_ALLOWLIST: readonly string[] = [
  // Boot (chicken-and-egg: needed to reach the DB at all)
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SECRETS_ENCRYPTION_KEY",
  // Instance infrastructure read via raw process.env at module init
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  // Runner bootstrap (the runner process reads these from this file at boot)
  "DEVPILOT_RUNNER_REGISTRATION_KEY",
  "DEVPILOT_RUNNER_TENANT_ID",
  // App + billing
  "NEXT_PUBLIC_APP_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];

export function isServerlessHost(): boolean {
  return Boolean(process.env.VERCEL);
}

/**
 * Locate `apps/web/.env.local`. `next dev`/`next start` run with
 * cwd = apps/web (pnpm --filter and turbo both exec scripts in the package
 * dir), so the common case is `./.env.local`; a repo-root launcher is handled
 * by the `apps/web/` candidate. Returns the path even when the file doesn't
 * exist yet (first run writes it), as long as the DIRECTORY is provably the
 * web app (has a next.config.*).
 */
export function locateEnvFile(): { path: string; exists: boolean } {
  const cwd = process.cwd();
  const candidateDirs = [cwd, join(cwd, "apps", "web")];
  for (const dir of candidateDirs) {
    const envPath = join(dir, ".env.local");
    if (existsSync(envPath)) return { path: envPath, exists: true };
  }
  for (const dir of candidateDirs) {
    const isWebAppDir = ["next.config.ts", "next.config.mjs", "next.config.js"].some((f) =>
      existsSync(join(dir, f)),
    );
    if (isWebAppDir) return { path: join(dir, ".env.local"), exists: false };
  }
  throw new Error(
    `Can't locate apps/web/.env.local from cwd=${cwd} — run the app via \`pnpm --filter web dev\`.`,
  );
}

function assertWritableKey(key: string): void {
  if (!ENV_WRITE_ALLOWLIST.includes(key)) {
    throw new Error(`${key} is not an env-managed setup key`);
  }
}

// Value serialisation lives in `./env-value` (no `server-only`) so the
// clone-time bootstrap script writes values by the same rule this file does.

const MANAGED_SECTION_HEADER = "# ── Added by DevPilot setup ──";

/**
 * Upsert the given keys into .env.local, preserving everything else. Rejects
 * (async) on serverless hosts, non-allowlisted keys, or unstorable values.
 * Calls are serialized through a module-level queue so concurrent saves can't
 * interleave the read-modify-write and drop each other's keys.
 */
export function writeEnvLocal(updates: Record<string, string>): Promise<{ path: string }> {
  const run = writeQueue.then(() => performWrite(updates));
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let writeQueue: Promise<void> = Promise.resolve();

function performWrite(updates: Record<string, string>): { path: string } {
  if (isServerlessHost()) {
    throw new Error(
      "This host has no writable env file (serverless). Set the variables in your deployment's environment settings instead.",
    );
  }
  const entries = Object.entries(updates);
  if (entries.length === 0) throw new Error("No values to write");
  for (const [key] of entries) assertWritableKey(key);

  const { path, exists } = locateEnvFile();
  const original = exists ? readFileSync(path, "utf8") : "";
  const lines = original.length > 0 ? original.split("\n") : [];

  // Both loaders are last-occurrence-wins, so a duplicated key must not leave
  // a stale later line behind: the first occurrence gets the new value, any
  // further occurrences are dropped.
  const pending = new Map(entries.map(([k, v]) => [k, serializeEnvValue(v)]));
  const replaced = new Set<string>();
  const next: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
    const key = m?.[1];
    const replacement = key === undefined ? undefined : pending.get(key);
    if (key === undefined || replacement === undefined) {
      next.push(line);
      continue;
    }
    if (!replaced.has(key)) {
      replaced.add(key);
      next.push(`${key}=${replacement}`);
    }
  }
  for (const key of replaced) pending.delete(key);

  if (pending.size > 0) {
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push(MANAGED_SECTION_HEADER);
    for (const [key, value] of pending) next.push(`${key}=${value}`);
    next.push("");
  }

  const content = next.join("\n");
  // Atomic replace: temp file in a private dir, then rename into place. The
  // temp dir lives on the same volume (alongside the target) so rename() stays
  // atomic rather than degrading to copy.
  const tmpDir = mkdtempSync(join(dirname(path), ".env-write-"));
  const tmpFile = join(tmpDir, "env.tmp");
  try {
    writeFileSync(tmpFile, content, { mode: exists ? statSync(path).mode : 0o600 });
    renameSync(tmpFile, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { path };
}
