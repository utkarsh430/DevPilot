// One-time local bootstrap for a fresh clone:
//
//   pnpm setup:local                      # interactive
//   pnpm setup:local --email you@x.com    # no prompt
//   pnpm setup:local --dry-run            # read-only: report what WOULD happen
//
// What it does, in order, printing each step:
//   1. checks the prerequisites (Node 20+, Docker running, Supabase CLI,
//      docker compose, `claude` signed in — the last is a warning only);
//   2. starts the local Supabase stack if it is not already up, and reads its
//      keys from `supabase status`;
//   3. starts the local Redis (infra/local/docker-compose.yml) — the stand-in
//      for the Upstash account a clone would otherwise need;
//   4. asks which email you will sign in with, creates that account in the
//      LOCAL Supabase, and reads the tenant it got — so the runner can be bound
//      to it before anyone has opened the app;
//   5. fills apps/web/.env.local from .env.example, generating the two secrets.
//
// RE-RUNNING IS SAFE. A value that is already set is never touched
// (`fillEnvTemplate`'s one rule), the account create is a no-op on an existing
// user, and compose/supabase are idempotent. To change a value, blank its
// line and re-run. Nothing here reads or writes anything outside this machine.
//
// Flags: --email <addr>  --yes (no prompts)  --dry-run  --no-start
//
// Every decision is in `../lib/dev/*.ts` and unit-tested; this file is IO.
// `node --import tsx`, relative imports only (see dev-inngest.mjs).

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { Client } from "pg";

import { fillEnvTemplate, missingKeys, parseDotenv } from "../lib/dev/env-template.ts";
import {
  MIN_NODE_MAJOR,
  REQUIRED_LOCAL_ENV_KEYS,
  LOCAL_REDIS_REST_TOKEN,
  LOCAL_REDIS_REST_URL,
  buildLocalEnvValues,
  generateLocalSecrets,
  localStackUrls,
  nodeMajor,
  supabaseStatusToEnv,
} from "../lib/dev/local-stack.ts";
import {
  OLDEST_TENANT_SQL,
  OWNER_TENANT_FOR_EMAIL_SQL,
  adminCreateUserRequest,
  classifyOperator,
  interpretAdminCreateUser,
  isValidEmail,
} from "../lib/dev/tenant-bootstrap.ts";
import {
  COMPOSE_FILE,
  ENV_PATH,
  ENV_TEMPLATE_PATH,
  claudeAuth,
  commandExists,
  dockerComposeAvailable,
  dockerComposeUp,
  dockerDaemonUp,
  httpJson,
  makeLog,
  parseArgs,
  redisPing,
  supabaseStart,
  supabaseStatus,
  waitFor,
  writeFileAtomic0600,
} from "./_local-stack-io.mjs";
import {
  REPO_DIR,
  SUPABASE_DOTENV_PATH,
  ensureDockerDaemon,
  ensureSupabaseUp,
  supabaseMigrateUp,
  supabaseStop,
} from "./_local-stack-io.mjs";
import {
  buildGithubEnvValues,
  buildSupabaseDotenvValues,
  envBackupPath,
  githubOauthHowto,
  inngestModeFor,
  runnerNameFor,
} from "../lib/dev/local-stack.ts";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname } from "node:path";

const log = makeLog("setup");
const { flags, values } = parseArgs(process.argv.slice(2), {
  valued: ["email", "github-client-id", "github-client-secret"],
});
const DRY_RUN = flags.has("dry-run");
const NO_START = flags.has("no-start");
const YES = flags.has("yes");
const FRESH = flags.has("fresh");
const STEPS = 9;
const warnings = [];
const step = (n, msg) => log.info(`${n}/${STEPS} ${msg}`);
const warn = (msg) => {
  warnings.push(msg);
  log.warn(msg);
};

for (const f of flags) {
  if (!["dry-run", "no-start", "yes", "fresh"].includes(f)) log.fatal(`unknown flag --${f}`);
}

// ── 1. Prerequisites ─────────────────────────────────────────────────────────
step(1, "checking prerequisites");
if (nodeMajor(process.versions.node) < MIN_NODE_MAJOR) {
  log.fatal(`Node ${process.versions.node} is too old — this repo needs Node ${MIN_NODE_MAJOR}+.`);
}
if (!/pnpm\/10\./.test(process.env.npm_config_user_agent ?? "")) {
  warn("not running under pnpm 10 (the repo pins pnpm@10.x in package.json; `corepack enable`).");
}
if (!commandExists("supabase")) {
  log.fatal(
    "supabase CLI not found on PATH. Install: brew install supabase/tap/supabase — then re-run.",
  );
}
await ensureDockerDaemon(log);
if (!dockerComposeAvailable()) {
  log.fatal(
    "docker compose (v2) not found — install a current Docker Desktop / docker-compose-plugin.",
  );
}
switch (claudeAuth()) {
  case "logged-in":
    break;
  case "missing":
    warn(
      "claude CLI not found — install it and sign in before running tickets (the runner executes on your Claude subscription).",
    );
    break;
  case "logged-out":
    warn(
      "claude is not logged in (claude auth status → loggedIn:false). Run `claude` once and sign in before running tickets.",
    );
    break;
  default:
    warn("could not tell whether claude is logged in (claude auth status printed no verdict).");
}

// ── 2. Supabase ──────────────────────────────────────────────────────────────
step(2, "local Supabase");
let status = supabaseStatus();
let supabaseWasRunning = status !== null;
if (status === null) {
  if (DRY_RUN)
    log.fatal("Supabase is not running; --dry-run will not start it (`supabase start`).");
  // Waits for containers Docker is already restarting, starts them otherwise,
  // and tolerates the CLI's non-zero "not ready: starting" exit (see the io helper).
  await ensureSupabaseUp(log, async () => supabaseStatus() !== null, { noStart: NO_START });
  status = supabaseStatus();
  if (status === null) log.fatal("Supabase came up but `supabase status` still reports nothing.");
}
let supabase;
try {
  supabase = supabaseStatusToEnv(status);
} catch (e) {
  log.fatal(e instanceof Error ? e.message : String(e));
}
log.info(
  `Supabase API ${supabase.NEXT_PUBLIC_SUPABASE_URL}${supabaseWasRunning ? " (already running)" : ""}`,
);
// A database that already existed may be BEHIND the code (a `git pull` with
// new migrations) - `supabase start` applies nothing to an existing volume.
if (supabaseWasRunning && !DRY_RUN && !NO_START) {
  log.info("applying any pending migrations (supabase migration up --local)");
  const code = await supabaseMigrateUp();
  if (code !== 0)
    warn("supabase migration up --local failed — the schema may be behind the code (see above)");
}

// ── 3. Redis ─────────────────────────────────────────────────────────────────
step(3, "local Redis (Upstash-compatible)");
if (!(await redisPing(LOCAL_REDIS_REST_URL, LOCAL_REDIS_REST_TOKEN))) {
  if (NO_START || DRY_RUN) {
    log.fatal(
      `Redis REST at ${LOCAL_REDIS_REST_URL} is not answering and starting it was disabled.`,
    );
  }
  const code = await dockerComposeUp();
  if (code !== 0) log.fatal(`docker compose -f ${COMPOSE_FILE} up -d exited with code ${code}.`);
  const ok = await waitFor(() => redisPing(LOCAL_REDIS_REST_URL, LOCAL_REDIS_REST_TOKEN), {
    timeoutMs: 30_000,
  });
  if (!ok) {
    log.fatal(
      `Redis REST at ${LOCAL_REDIS_REST_URL} never answered PONG. Inspect: docker compose -f ${COMPOSE_FILE} logs`,
    );
  }
}
log.info(`Redis REST ${LOCAL_REDIS_REST_URL} answers PONG`);

// ── 4. Which email will you sign in with? ────────────────────────────────────
step(4, "sign-in account");
// A copy of .env.local lives outside the repo (step 8 writes it). If the file
// is gone - `git clean -fdx`, a re-clone into the same path - restore it FIRST,
// because it holds SECRETS_ENCRYPTION_KEY, without which every secret already
// stored in the local database is unreadable. `--fresh` says: don't.
const BACKUP_PATH = envBackupPath(homedir(), REPO_DIR);
if (!existsSync(ENV_PATH) && existsSync(BACKUP_PATH)) {
  if (FRESH) {
    log.info(`ignoring the earlier .env.local backup (--fresh): ${BACKUP_PATH}`);
  } else if (!DRY_RUN) {
    log.info(`no .env.local, but a backup from an earlier setup exists — restoring it`);
    log.info(
      `  (keeps your encryption key + runner registration; --fresh ignores it): ${BACKUP_PATH}`,
    );
    copyFileSync(BACKUP_PATH, ENV_PATH);
    chmodSync(ENV_PATH, 0o600);
  }
}
const existingEnv = existsSync(ENV_PATH) ? parseDotenv(readFileSync(ENV_PATH, "utf8")) : {};
let email = (values.email ?? "").trim();
if (!email && (existingEnv.DEVPILOT_RUNNER_TENANT_ID ?? "").trim()) {
  log.info("DEVPILOT_RUNNER_TENANT_ID is already set in .env.local — skipping the account step");
} else if (!email && input.isTTY && !YES && !DRY_RUN) {
  const rl = createInterface({ input, output });
  try {
    email = (await rl.question("Email you will sign in with (blank to skip): ")).trim();
  } finally {
    rl.close();
  }
}
if (email && !isValidEmail(email)) log.fatal(`"${email}" is not an email address.`);

// ── 5. Create the account, read its tenant ───────────────────────────────────
step(5, "tenant for the runner");
let tenantId = (existingEnv.DEVPILOT_RUNNER_TENANT_ID ?? "").trim() || undefined;
if (DRY_RUN) {
  log.info("--dry-run: not creating an account");
} else if (!email && !tenantId) {
  warn(
    "no email given (and no --email, or stdin is not a TTY) — skipping the account step. " +
      "DEVPILOT_RUNNER_TENANT_ID stays blank and the runner will refuse to boot. " +
      "Re-run: pnpm setup:local --email you@example.com",
  );
} else if (email) {
  const req = adminCreateUserRequest(
    supabase.NEXT_PUBLIC_SUPABASE_URL,
    supabase.SUPABASE_SECRET_KEY,
    email,
  );
  const { status: httpStatusCode, body } = await httpJson(req.url, req.init);
  if (httpStatusCode === null) log.fatal(`could not reach the local auth API: ${body}`);
  const outcome = interpretAdminCreateUser(httpStatusCode, body);
  if (typeof outcome !== "string") log.fatal(outcome.error);
  log.info(`account ${email}: ${outcome === "created" ? "created" : "already exists"}`);

  const db = new Client({ connectionString: supabase.DATABASE_URL });
  await db.connect();
  try {
    let mine = null;
    await waitFor(
      async () => {
        const r = await db.query(OWNER_TENANT_FOR_EMAIL_SQL, [email]);
        mine = r.rows[0] ?? null;
        return mine !== null;
      },
      { timeoutMs: 5000, intervalMs: 500 },
    );
    if (!mine) {
      log.fatal(
        "the user exists but no owner tenant appeared within 5s — the handle_new_user trigger is missing; run `supabase db reset` and re-run.",
      );
    }
    tenantId = mine.id;
    const oldest = (await db.query(OLDEST_TENANT_SQL)).rows[0] ?? null;
    const verdict = classifyOperator(oldest, mine);
    log.info(`tenant ${mine.id} ("${mine.name}")`);
    if (!verdict.operator) warn(verdict.reason);
  } finally {
    await db.end();
  }
}

// ── 6. GitHub OAuth app (the one credential a clone cannot generate) ─────────
step(6, "GitHub OAuth app (optional - needed to create or connect projects)");
const urls = localStackUrls(status);
const howto = githubOauthHowto(supabase.NEXT_PUBLIC_SUPABASE_URL, urls.app);
const supaDotenv = existsSync(SUPABASE_DOTENV_PATH)
  ? parseDotenv(readFileSync(SUPABASE_DOTENV_PATH, "utf8"))
  : {};
const githubAlready = (supaDotenv.SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID ?? "").trim().length > 0;
let ghId = (values["github-client-id"] ?? "").trim();
let ghSecret = (values["github-client-secret"] ?? "").trim();
if (!ghId && !githubAlready && input.isTTY && !YES && !DRY_RUN) {
  for (const line of howto) log.info(`  ${line}`);
  const rl = createInterface({ input, output });
  try {
    ghId = (await rl.question("GitHub OAuth App client ID (blank to skip for now): ")).trim();
    if (ghId) ghSecret = (await rl.question("GitHub OAuth App client secret: ")).trim();
  } finally {
    rl.close();
  }
}
if (ghId && !ghSecret) log.fatal("--github-client-secret is required alongside --github-client-id");
let github = null;
let githubConfigured = githubAlready;
if (ghId && ghSecret) {
  github = { clientId: ghId, clientSecret: ghSecret };
  githubConfigured = true;
  if (!DRY_RUN) {
    const baseDotenv = existsSync(SUPABASE_DOTENV_PATH)
      ? readFileSync(SUPABASE_DOTENV_PATH, "utf8")
      : "";
    const filled = fillEnvTemplate(baseDotenv, buildSupabaseDotenvValues(github));
    writeFileAtomic0600(SUPABASE_DOTENV_PATH, filled.content);
    for (const r of filled.report) log.info(`  supabase/.env ${r.key.padEnd(44)} ${r.action}`);
    if (filled.report.every((r) => r.action === "kept")) {
      log.info("  (supabase/.env already held values; blank its lines and re-run to replace them)");
    } else if (supabaseWasRunning && !NO_START) {
      // GoTrue reads supabase/.env at start, so a running stack does not see
      // the new values until it is restarted. Data survives (`stop` backs up).
      log.info("restarting local Supabase so GoTrue picks up the GitHub app");
      await supabaseStop();
      const code = await supabaseStart();
      if (code !== 0) log.fatal(`supabase start exited with code ${code} after the restart.`);
    }
  }
} else if (githubAlready) {
  log.info("GitHub OAuth app already configured in supabase/.env");
} else {
  warn(
    "no GitHub OAuth app configured yet - projects cannot be created or connected until one is (see the summary)",
  );
}

// ── 7. Assemble ──────────────────────────────────────────────────────────────
step(7, "assembling apps/web/.env.local");
const base = existsSync(ENV_PATH)
  ? readFileSync(ENV_PATH, "utf8")
  : readFileSync(ENV_TEMPLATE_PATH, "utf8");
const envValues = {
  ...buildLocalEnvValues({
    supabase,
    secrets: generateLocalSecrets(randomBytes),
    tenantId,
    runnerName: runnerNameFor(hostname()),
  }),
  ...(github ? buildGithubEnvValues(github) : {}),
};
const { content, report } = fillEnvTemplate(base, envValues);
const width = Math.max(...report.map((r) => r.key.length));
for (const r of report) log.info(`  ${r.key.padEnd(width)}  ${r.action}`);

// ── 8. Write (+ the out-of-repo backup) ──────────────────────────────────────
step(8, DRY_RUN ? "not writing (--dry-run)" : `writing ${ENV_PATH}`);
if (!DRY_RUN) {
  writeFileAtomic0600(ENV_PATH, content);
  mkdirSync(dirname(BACKUP_PATH), { recursive: true });
  copyFileSync(ENV_PATH, BACKUP_PATH);
  chmodSync(BACKUP_PATH, 0o600);
  log.info(`  backup copy: ${BACKUP_PATH}`);
}
const finalEnv = parseDotenv(content);
const stillMissing = missingKeys(finalEnv, REQUIRED_LOCAL_ENV_KEYS);
if (inngestModeFor(finalEnv) === "dev") {
  warn(
    "Inngest stays in dev-server mode (INNGEST_DEV is not 0 in .env.local - an earlier setup wrote 1): in-flight runs will not survive a restart. For the durable server: set INNGEST_DEV=0 and re-run pnpm setup:local.",
  );
}

// ── 9. Summary ───────────────────────────────────────────────────────────────
step(9, "done");
log.info("");
log.info(`  next:      pnpm dev:local`);
log.info(`  app:       ${urls.app}`);
log.info(`  mailpit:   ${urls.mailpit}   <- sign-in links land here (nothing is emailed)`);
log.info(`  studio:    ${urls.studio}`);
if (stillMissing.length > 0) {
  log.info("");
  warn(`.env.local still lacks: ${stillMissing.join(", ")}`);
}
if (!githubConfigured) {
  log.info("");
  for (const line of howto) log.info(`  ${line}`);
}
if (supabaseWasRunning) {
  log.info("");
  log.info(
    "  Supabase was already running. If you just pulled a change to supabase/config.toml, apply it with: supabase stop && supabase start",
  );
}
if (warnings.length > 0) {
  log.info("");
  log.info(`  ${warnings.length} warning(s) above.`);
}
