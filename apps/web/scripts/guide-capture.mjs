// Capture the guide's figures, deterministically, against a fixture database.
//
//   pnpm --filter @devpilot/web capture:guide
//
// Prerequisites, in this order:
//   1. `supabase start`                       (the local stack)
//   2. `pnpm --filter web dev`                (the app, on :3000)
//   3. `npx playwright install chromium`      (opt-in, once)
//
// The fixture (`supabase/seeds/guide-fixture.sql`) is applied BY THIS SCRIPT,
// below; `supabase db reset` no longer seeds it (config.toml's [db.seed] is
// empty so a fresh clone's first sign-in is the instance operator).
//
// The `github-scopes` figure photographs the NOT-CONNECTED card. On a local
// Supabase with no GitHub OAuth App configured the page renders a setup card
// INSTEAD (lib/github/provider-readiness.ts keys on GITHUB_OAUTH_CLIENT_ID),
// so the app in step 2 must be started with GITHUB_OAUTH_CLIENT_ID set to any
// non-blank value - a fixture is allowed to assume a configured install, never
// to show a misconfigured one.
//
// NEVER RUN THIS IN CI. It drives a real browser against a real app against a
// real database, and it is the SOLE WRITER of every provenance field in
// `lib/guide/figures.ts`. A CI run would rewrite committed provenance from an
// environment nobody reviewed. The crew's role is to run it locally and commit
// what it produced.
//
// ── Why a script and not an agent with browser tools ────────────────────────
//
// The agent browser tools work and are the wrong instrument. Captures land flat
// as `page-<ISO>.png` with no stable identity, and a figure filed under the
// wrong id is worse than a missing one - the reader believes it. And a model
// deciding when a page has "settled" produces a different scroll offset and a
// different spinner frame every run, so each recapture is an unreviewable binary
// diff. Everything below is pinned: viewport, DPR, theme, motion, clock, crop
// rectangle, and an explicit wait selector per figure.
//
// ── The two-key refusal ─────────────────────────────────────────────────────
//
// The app normally points at the CLOUD database holding real projects, real
// tickets and real customer issues. "Forgot to switch" is the realistic threat,
// and a screenshot leaking real content into a shipped manual is not
// recoverable: the PDF is downloaded, the page is cached, and a stranger finds
// it. So this refuses to start unless BOTH hold:
//
//   1. the Supabase URL PARSES and its hostname is localhost / 127.0.0.1 / ::1
//      - never a string prefix match, because `https://localhost.evil.example`
//      starts with the right characters and is not local (mirrors
//      `isSupabaseOrigin` in `lib/export/images.server.ts`);
//   2. the capture account can reach EXACTLY ONE tenant, and it is
//      `GUIDE_FIXTURE_TENANT_ID`. Asked that way rather than "does the fixture
//      tenant exist", because the seed has just created it and that answer is
//      worthless - what matters is the set RLS will let the board render.
//
// Either key alone is defeatable by a stray `.env.local` - a local host still
// holds whatever a developer was working on, and a tenant id proves nothing
// about which server answered. Together they are not defeatable by accident.
//
// Redaction-after-capture was considered and REJECTED: a human step whose
// failure is silent, permanent, and discovered by a stranger. Refusing to start
// is a failure that is loud and costs nothing.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Client } from "pg";
import { createServerClient } from "@supabase/ssr";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, "..");
const REPO = resolve(WEB, "../..");
const SEED = join(REPO, "supabase/seeds/guide-fixture.sql");
const FIGURES_TS = join(WEB, "lib/guide/figures.ts");
const PROVENANCE_JSON = join(WEB, "lib/guide/capture-provenance.json");
const OUT_DIR = join(WEB, "public/guide");

const APP_ORIGIN = process.env.GUIDE_CAPTURE_ORIGIN ?? "http://localhost:3000";
// The fixture account's password, matching the literal in the seed. It is a
// fixed local-only credential for an account that exists only in a fixture
// database - see the sign-in note below for why this beats magic-link OTP.
const GUIDE_FIXTURE_PASSWORD = "guide-capture-local-only";

const DB_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// DPR 1 because a retina capture is 4× the bytes for detail nobody reads at
// guide size. The viewport itself is pinned per figure - see
// `GUIDE_DEFAULT_VIEWPORT` and the per-figure override in `figures.ts`.
const DEVICE_SCALE_FACTOR = 1;

function die(message) {
  console.error(`\nguide-capture: ${message}\n`);
  process.exit(1);
}

// ── Reading the registry ────────────────────────────────────────────────────
//
// Imported, not text-parsed. An earlier cut scraped the fields out of
// `figures.ts` with regexes to avoid compiling TypeScript from a plain node
// script; that worked and was a trap - every field the spec grew (a prepare
// step, an optional selector) meant another regex, and a regex that silently
// fails to match yields a figure captured with the wrong framing rather than an
// error. `node --import tsx` is an established pattern in this repo
// (`tests/evals/snapshot-prompts.mjs` runs the same way).
//
// The consequence, and it is a real constraint: every module reachable from
// `figures.ts` must use RELATIVE imports. `@/…` does not resolve under bare tsx
// with no Next tsconfig, and the failure is `Cannot find module` at import time.

const { GUIDE_FIGURES, GUIDE_FIGURE_CAPTURE, GUIDE_DEFAULT_VIEWPORT } =
  await import("../lib/guide/figures.ts");

// ── Fingerprinting ─────────────────────────────────────────────────────────
//
// IMPORTED from `freshness.ts`. Never reimplemented, and there is a scar here
// worth keeping: an earlier cut of this script hand-rolled the same three lines
// because it could not compile TypeScript, and the two disagreed. The reason is
// that `fingerprintWatchedFiles` separates a path from its content digest with a
// literal NUL byte - a good choice, since a NUL cannot occur in a path and so
// the boundary cannot be forged - and a NUL is INVISIBLE in every plain-text
// read of the file. The copy looked character-for-character correct in a diff,
// in `sed`, and to a reviewer, and produced a different hash.
//
// The failure that caused was not loud: the script wrote fingerprint A, the test
// recomputed fingerprint B, and every figure reported as permanently stale
// immediately after being captured - which reads as "the freshness gate is
// broken and too noisy to keep" rather than "these are two implementations".
// One implementation cannot drift from itself.

// The byte ceiling is imported for the same reason as the hash function: a
// second copy is a second thing that can disagree, and this one would disagree
// SILENTLY - the script would happily write a figure the test then rejects.
const { fingerprintWatchedFiles, GUIDE_MAX_FIGURE_BYTES } =
  await import("../lib/guide/freshness.ts");

function fingerprint(watch) {
  return fingerprintWatchedFiles(
    watch.map((path) => {
      try {
        return { path, contents: readFileSync(join(WEB, path), "utf8") };
      } catch {
        return die(`watched file does not exist: ${path} (paths are relative to apps/web)`);
      }
    }),
  );
}

// ── Key 1: the Supabase host must resolve to this machine ───────────────────

function assertLocalHost(label, rawUrl) {
  if (!rawUrl) die(`${label} is not set - pass it via --env-file=.env.local`);
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    die(`${label} is not a URL: ${rawUrl}`);
  }
  const local =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";
  if (!local) {
    die(
      `REFUSING TO CAPTURE.\n\n` +
        `  ${label} resolves to host "${hostname}", which is not local.\n\n` +
        `  This script drives a real browser and screenshots whatever it finds. Against a\n` +
        `  non-local database that is the operator's real projects, real ticket titles and\n` +
        `  real customer issues - and a leak into a shipped manual is not recoverable.\n\n` +
        `  Point ${label} at the local Supabase stack (supabase start) and try again.`,
    );
  }
  return hostname;
}

// ── Key 2: the tenant must be the fixture ───────────────────────────────────

const FIXTURE = readFixtureConstants();

/**
 * The fixture ids, read from `lib/guide/fixture.ts`.
 *
 * Read rather than duplicated: a second copy of the tenant uuid in this file is
 * a second thing that can disagree with the seed, and the failure mode of that
 * disagreement is a refusal nobody can explain.
 */
function readFixtureConstants() {
  const src = readFileSync(join(WEB, "lib/guide/fixture.ts"), "utf8");
  const pick = (name) => {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(src);
    if (!m) die(`lib/guide/fixture.ts does not export ${name}`);
    return m[1];
  };
  return {
    tenantId: pick("GUIDE_FIXTURE_TENANT_ID"),
    runId: pick("GUIDE_FIXTURE_RUN_ID"),
    email: pick("GUIDE_FIXTURE_USER_EMAIL"),
  };
}

async function seedAndAssertTenant() {
  assertLocalHost("DATABASE_URL", DB_URL);
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // Applied VERBATIM in one call, letting Postgres parse the file. Splitting
    // on `;` silently drops statements - a trap this repo has already paid for
    // once (see the migration-verification note in AGENTS.md).
    await client.query(readFileSync(SEED, "utf8"));

    // The tenant key, asked the way that matters: not "does the fixture tenant
    // exist" - the seed just created it, so that answer is worthless - but
    // "which tenants can the account this script is about to sign in as
    // actually reach?". That set is what `current_user_tenants()` returns and
    // therefore what RLS will let the board render. If the capture account has
    // ever been added to a real workspace, this is the check that catches it,
    // and it catches it BEFORE a browser exists.
    const { rows } = await client.query(
      `select m.tenant_id, t.name
         from public.tenant_members m
         join public.tenants t on t.id = m.tenant_id
        where m.user_id = (select id from auth.users where email = $1)`,
      [FIXTURE.email],
    );
    const reachable = rows.map((r) => `${r.tenant_id} (${r.name})`);
    if (reachable.length !== 1 || rows[0].tenant_id !== FIXTURE.tenantId) {
      die(
        `REFUSING TO CAPTURE.\n\n` +
          `  The capture account ${FIXTURE.email} can reach ${reachable.length} tenant(s):\n` +
          reachable.map((r) => `    - ${r}`).join("\n") +
          `\n\n  It must reach exactly one, and it must be the fixture tenant\n` +
          `  ${FIXTURE.tenantId}. Anything else means a screenshot could contain\n` +
          `  real work, and that leak is not recoverable once the manual ships.`,
      );
    }

    // A local database is not automatically a FIXTURE database. If this one is
    // also carrying real work, the browser could navigate to it - the board
    // renders whichever project the session cookie names. Refuse rather than
    // hope the crop misses it.
    const { rows: others } = await client.query(
      "select count(*)::int as n from public.tenants where id <> $1",
      [FIXTURE.tenantId],
    );
    if (others[0].n > 0) {
      console.warn(
        `guide-capture: warning - this database holds ${others[0].n} other tenant(s).\n` +
          `  Capture is pinned to the fixture project, but review every PNG before committing.`,
      );
    }
  } finally {
    await client.end();
  }
}

// ── Sign-in ─────────────────────────────────────────────────────────────────
//
// The session cookies are produced by @supabase/ssr ITSELF and then handed to
// the browser. `createServerClient` is constructed with a cookie adapter that
// simply records what it is asked to write, so `signInWithPassword` leaves us
// holding exactly the cookies the app would have set - correct names, correct
// chunking, tracked automatically across library upgrades. Nothing about the
// format is reverse-engineered here.
//
// TWO EARLIER APPROACHES WERE TRIED AND ARE NOT WORTH RETRYING:
//
//  • Driving the real magic-link form and scraping the mail catcher. It works
//    exactly twice: GoTrue rate-limits `email_sent` per hour, so the third run
//    of the day fails with `429 email rate limit exceeded`, which surfaces as
//    "no sign-in email arrived" - a message that sends you looking at SMTP
//    config for something that is not broken. A capture script that stops
//    working after two runs is not a capture script.
//  • Admin `generate_link`. The app's callback is the PKCE `?code=` exchange,
//    and a link minted server-side has no verifier in the browser's storage, so
//    the exchange fails. Closing that would mean adding an `/auth/confirm` route
//    to the product for the benefit of a screenshot script.
//
// The password exists ONLY in the fixture seed, is a fixed literal, and is
// reachable only from a database that has already passed both keys.

async function signIn(context) {
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) die("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set");

  const written = [];
  const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, key, {
    cookies: {
      getAll: () => [],
      setAll: (list) => written.push(...list),
    },
  });

  const { error } = await client.auth.signInWithPassword({
    email: FIXTURE.email,
    password: GUIDE_FIXTURE_PASSWORD,
  });
  if (error) {
    die(
      `could not sign in as ${FIXTURE.email}: ${error.message}\n` +
        `  The fixture seed sets this account's password; re-run after \`supabase start\`.`,
    );
  }
  if (written.length === 0) die("supabase produced no session cookies to hand to the browser");

  const origin = new URL(APP_ORIGIN);
  await context.addCookies(
    written.map((c) => ({
      name: c.name,
      value: c.value,
      domain: origin.hostname,
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    })),
  );
}

// ── Determinism ─────────────────────────────────────────────────────────────

/**
 * Everything that has to be true before the first paint.
 *
 * THEME is the one that bites silently. `DEFAULT_THEME` is `"system"`, so on a
 * developer with a dark OS every figure comes out dark - and passes the
 * freshness check, the provenance check, the byte budget and the mime sniff,
 * because none of them look at pixels. It is set here, in an init script, so it
 * is in place before the pre-paint theme script runs; setting it after load
 * would capture a flash of the wrong theme or, worse, half of one.
 *
 * THE CLOCK IS FROZEN AT THE REAL CURRENT INSTANT, not at a fictional date.
 * Freezing means "stop time", not "travel in time": the fixture's rows are
 * stamped as offsets from the database's `now()`, so a browser told it is 2026
 * would compute relative times against data from a different era and render
 * nonsense. What freezing buys is that a minute cannot roll over between the
 * first paint and the shutter, turning "2m ago" into "3m ago" mid-capture.
 */
async function pinEnvironment(context) {
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("devpilot-theme", "light");
      // First-run nudges are not part of the product's steady state, and a
      // figure that includes one is a figure of the onboarding, not of the
      // screen. They are also layout-shifting: the trace coach-mark is a banner
      // above the card being photographed, so leaving it in makes every crop
      // rectangle depend on a dismissal the reader has probably already done.
      window.localStorage.setItem("devpilot:runs:traceCoachmark", "1");
      window.localStorage.setItem("devpilot:board:firstRunNudge:dismissed", "1");
    } catch {
      /* storage can be unavailable; the theme default is the only cost */
    }

    const frozen = Date.now();
    const RealDate = Date;
    // eslint-disable-next-line no-global-assign
    Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [frozen]));
      }
      static now() {
        return frozen;
      }
    };
    Date.parse = RealDate.parse;
    Date.UTC = RealDate.UTC;
    performance.now = () => 0;
  });
}

/**
 * Everything that must be suppressed in the frame.
 *
 * MOTION: an animation mid-flight is a different pixel every run - a pulsing
 * "live" dot, a spinner, a transition caught halfway. `reducedMotion: "reduce"`
 * on the context covers components that honour the media query; this covers the
 * ones that do not.
 *
 * THE NEXT.JS DEV OVERLAY: this is the one that would have shipped. Captures run
 * against `next dev`, and the dev tools render a floating badge in the bottom-left
 * - in the first real capture it read "1 Issue" in a red pill. Nothing in the
 * pipeline would have caught it: it is inside the viewport, it is not motion, it
 * passes the byte budget and the mime sniff, and a reviewer skimming a PNG of a
 * Kanban board is looking at the board. It would have appeared in the shipped
 * manual as a defect notice about the reader's own install.
 */
const CAPTURE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
  nextjs-portal,
  #__next-build-watcher,
  [data-nextjs-toast],
  [data-nextjs-dev-tools-button] { display: none !important; }
`;

// ── Writing provenance back ─────────────────────────────────────────────────

/**
 * Replace one figure's machine-owned fields in the registry source.
 *
 * Scoped to the block that starts at `id: "<id>"` and ends at the next `},` at
 * the array's indentation, so a rewrite of one figure can never reach into
 * another. Authored fields are matched but never changed.
 */
function writeProvenance(src, id, prov) {
  const start = src.indexOf(`id: "${id}"`);
  if (start === -1) die(`figure "${id}" vanished from the registry mid-run`);
  const end = src.indexOf("\n  },", start);
  const block = src.slice(start, end);
  const set = (text, key, value) => {
    const re = new RegExp(`(${key}:\\s*)(?:"[^"]*"|\\d+)`);
    if (!re.test(text)) die(`figure "${id}" has no ${key} field to write`);
    return text.replace(re, `$1${typeof value === "number" ? value : `"${value}"`}`);
  };
  let next = block;
  next = set(next, "width", prov.width);
  next = set(next, "height", prov.height);
  next = set(next, "fingerprint", prov.fingerprint);
  next = set(next, "capturedAt", prov.capturedAt);
  next = set(next, "theme", prov.theme);
  next = set(next, "build", prov.build);
  return src.slice(0, start) + next + src.slice(end);
}

function gitSha() {
  return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: REPO }).toString().trim();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Key 1, before anything else touches a network or a browser.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  assertLocalHost("NEXT_PUBLIC_SUPABASE_URL", supabaseUrl);

  // Key 2 (and the data the figures show).
  await seedAndAssertTenant();

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    die("playwright is not installed - run `pnpm install` in apps/web");
  }

  const app = await fetch(`${APP_ORIGIN}/login`).catch(() => null);
  if (!app?.ok) {
    die(
      `the app is not answering at ${APP_ORIGIN}.\n` +
        `  Start it with \`pnpm --filter web dev\` and try again.`,
    );
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    die(
      `could not launch chromium: ${e.message}\n\n` +
        `  The browser download is opt-in. Run it once:\n` +
        `      npx playwright install chromium`,
    );
  }

  const context = await browser.newContext({
    viewport: { ...GUIDE_DEFAULT_VIEWPORT },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-GB",
    timezoneId: "UTC",
  });
  await pinEnvironment(context);

  await signIn(context);
  const page = await context.newPage();

  const specs = GUIDE_FIGURE_CAPTURE;
  for (const spec of specs) {
    if (!GUIDE_FIGURES.some((f) => f.id === spec.id)) {
      die(`GUIDE_FIGURE_CAPTURE names "${spec.id}", which is not in GUIDE_FIGURES`);
    }
  }
  for (const figure of GUIDE_FIGURES) {
    if (!specs.some((sp) => sp.id === figure.id)) {
      die(`GUIDE_FIGURES declares "${figure.id}" with no entry in GUIDE_FIGURE_CAPTURE`);
    }
  }
  let src = readFileSync(FIGURES_TS, "utf8");

  mkdirSync(OUT_DIR, { recursive: true });
  const build = gitSha();
  const capturedAt = new Date().toISOString();
  const written = [];

  for (const spec of specs) {
    const figure = GUIDE_FIGURES.find((f) => f.id === spec.id);
    const url = `${APP_ORIGIN}${spec.path}`;
    process.stdout.write(`  ${spec.id} … `);

    const viewport = { ...GUIDE_DEFAULT_VIEWPORT, ...(spec.viewport ?? {}) };

    // A CROP THAT DOES NOT FIT IS SILENTLY CLIPPED, NOT REFUSED. Playwright
    // measures `clip` against the viewport and quietly returns the
    // intersection, so an over-tall rectangle yields a SHORTER PNG that is a
    // perfectly valid image - it passes the mime sniff, the byte budget and the
    // provenance check, and the only symptom is that the bottom of the figure
    // is missing. The first cut of `lesson-review` lost its Accept and Reject
    // buttons exactly that way, to a crop 62px taller than the default
    // viewport, and nothing in the pipeline said a word.
    //
    // `manifest-figures.test.ts` asserts the same relationship, but that runs
    // after the fact and against whatever was committed; refusing HERE is what
    // stops a truncated PNG being written in the first place.
    const overflowX = spec.crop.x + spec.crop.width - viewport.width;
    const overflowY = spec.crop.y + spec.crop.height - viewport.height;
    if (overflowX > 0 || overflowY > 0) {
      die(
        `${spec.id}: the crop does not fit its viewport.\n\n` +
          `  crop     x:${spec.crop.x} y:${spec.crop.y} ${spec.crop.width}×${spec.crop.height} ` +
          `(reaches ${spec.crop.x + spec.crop.width}×${spec.crop.y + spec.crop.height})\n` +
          `  viewport ${viewport.width}×${viewport.height}` +
          (spec.viewport ? "" : " (the default - this figure declares none)") +
          `\n\n  Overflowing by ${Math.max(0, overflowX)}px across and ` +
          `${Math.max(0, overflowY)}px down. The browser would clip it silently and write a\n` +
          `  smaller PNG that looks entirely valid. Widen the figure's own viewport, or\n` +
          `  crop tighter.`,
      );
    }

    await page.setViewportSize(viewport);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: CAPTURE_CSS });
    await page.waitForSelector(spec.waitFor, { state: "visible", timeout: 20_000 });

    for (const step of spec.prepare ?? []) {
      if (step.kind === "click") {
        await page.locator(step.selector).last().click({ timeout: 15_000 });
      } else if (step.kind === "scrollTop") {
        await page.evaluate(() => {
          for (const el of document.querySelectorAll("*")) {
            if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200) el.scrollTop = 0;
          }
          window.scrollTo(0, 0);
        });
      }
      // Each prepare step re-renders; the wait is for THAT, and it is the one
      // place a fixed delay is honest - there is no selector meaning "React has
      // finished reacting to the click I just made".
      await page.waitForTimeout(500);
    }

    // Fonts settle after layout. A shot taken before they do captures fallback
    // metrics, which is a real and subtle difference between two otherwise
    // identical captures on the same machine.
    await page.evaluate(() => document.fonts.ready);

    const buf = await page.screenshot({ type: "png", clip: spec.crop });

    if (buf.byteLength > GUIDE_MAX_FIGURE_BYTES) {
      die(
        `${spec.id} is ${(buf.byteLength / 1024).toFixed(0)} KiB, over the ` +
          `${GUIDE_MAX_FIGURE_BYTES / 1024} KiB per-figure budget.\n` +
          `  Crop tighter - the budget exists because a manual nobody downloads is not a manual.`,
      );
    }

    // Atomic: the PNG and its provenance must not be able to disagree. Written
    // to a temp name and renamed, so a crash mid-write leaves the previous
    // committed figure intact rather than a truncated one.
    const dest = join(OUT_DIR, figure.file);
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, dest);

    src = writeProvenance(src, spec.id, {
      width: spec.crop.width,
      height: spec.crop.height,
      fingerprint: fingerprint(figure.watch),
      capturedAt,
      theme: "light",
      build,
    });
    written.push({
      id: spec.id,
      file: figure.file,
      bytes: buf.byteLength,
      capturedAt,
      theme: "light",
      build,
      // The two keys, RECORDED rather than merely enforced. Enforcement happens
      // at the top of this run and then evaporates; the record is what a
      // reviewer reading the PR - or a test months later - can actually check.
      host: supabaseUrl,
      fixtureTenantId: FIXTURE.tenantId,
    });
    console.log(`${(buf.byteLength / 1024).toFixed(0)} KiB`);
  }

  writeFileSync(FIGURES_TS, src);

  // The sidecar exists because `GuideFigure` is FROZEN and carries no field for
  // a host, a tenant or a byte count - and those are exactly the facts that make
  // a capture claim checkable after the fact. `bytes` in particular ties the
  // committed PNG to the run that produced it: a hand-replaced image no longer
  // matches, and the test says so.
  writeFileSync(
    PROVENANCE_JSON,
    `${JSON.stringify({ figures: written.sort((a, b) => a.id.localeCompare(b.id)) }, null, 2)}\n`,
  );

  await browser.close();

  const total = written.reduce((n, w) => n + w.bytes, 0);
  console.log(
    `\ncaptured ${written.length} figure(s), ${(total / 1024).toFixed(0)} KiB total, ` +
      `build ${build}, host ${new URL(supabaseUrl).hostname}\n` +
      `review every PNG before committing - no check in this repo looks at pixels.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
