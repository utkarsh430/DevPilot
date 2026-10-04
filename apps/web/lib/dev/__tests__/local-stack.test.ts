import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LOCAL_APP_URL,
  LOCAL_REDIS_REST_TOKEN,
  LOCAL_INNGEST_REDIS_URI,
  LOCAL_REDIS_REST_URL,
  REQUIRED_LOCAL_ENV_KEYS,
  SUPABASE_DOTENV_GITHUB_KEYS,
  buildGithubEnvValues,
  buildLocalEnvValues,
  buildSupabaseDotenvValues,
  classifyClaudeAuth,
  classifySupabaseContainer,
  decideSupabaseBringUp,
  envBackupPath,
  generateLocalSecrets,
  githubCallbackUrl,
  githubOauthHowto,
  inngestModeFor,
  inngestServerSpec,
  isInstallStale,
  isLocalRedisUrl,
  isPong,
  localStackUrls,
  nodeMajor,
  parseSupabaseStatus,
  requiredLocalEnvKeysFor,
  runnerNameFor,
  stripSigningKeyPrefix,
  supabaseStatusToEnv,
} from "@/lib/dev/local-stack";

const COMPOSE_PATH = fileURLToPath(
  new URL("../../../../../infra/local/docker-compose.yml", import.meta.url),
);

// The shape `supabase status -o json` printed on 2026-10-02 (CLI 2.117).
const STATUS = {
  API_URL: "http://127.0.0.1:54321",
  DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  MAILPIT_URL: "http://127.0.0.1:54324",
  INBUCKET_URL: "http://127.0.0.1:54324",
  PUBLISHABLE_KEY: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH",
  SECRET_KEY: "sb_secret_FIXTURE",
  STUDIO_URL: "http://127.0.0.1:54323",
  ANON_KEY: "eyJhbGciOiJIUzI1NiJ9.e30.x",
  SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.e30.y",
};

describe("parseSupabaseStatus", () => {
  it("extracts the object from stdout with noise around it", () => {
    const stdout = `Stopped services: [supabase_imgproxy]\n${JSON.stringify(STATUS, null, 2)}\nA new version is available\n`;
    expect(parseSupabaseStatus(stdout)).toEqual(STATUS);
  });

  it("throws with a hint when there is no object", () => {
    expect(() => parseSupabaseStatus("supabase local development setup is not running.\n")).toThrow(
      /supabase start/,
    );
  });
});

describe("supabaseStatusToEnv", () => {
  it("maps the five keys, preferring MAILPIT_URL", () => {
    expect(supabaseStatusToEnv(STATUS)).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: STATUS.PUBLISHABLE_KEY,
      SUPABASE_SECRET_KEY: STATUS.SECRET_KEY,
      DATABASE_URL: STATUS.DB_URL,
      NEXT_PUBLIC_LOCAL_MAIL_URL: "http://127.0.0.1:54324",
    });
  });

  it("falls back to INBUCKET_URL, then blank", () => {
    const { MAILPIT_URL: _m, ...noMailpit } = STATUS;
    expect(supabaseStatusToEnv(noMailpit).NEXT_PUBLIC_LOCAL_MAIL_URL).toBe(STATUS.INBUCKET_URL);
    const { INBUCKET_URL: _i, ...neither } = noMailpit;
    expect(supabaseStatusToEnv(neither).NEXT_PUBLIC_LOCAL_MAIL_URL).toBe("");
  });

  it("names every missing key on an old CLI that only reports JWT keys", () => {
    const old = { API_URL: STATUS.API_URL, ANON_KEY: "x", SERVICE_ROLE_KEY: "y" };
    expect(() => supabaseStatusToEnv(old)).toThrow(/PUBLISHABLE_KEY, SECRET_KEY, DB_URL/);
  });

  it("refuses a JWT in the publishable slot", () => {
    expect(() => supabaseStatusToEnv({ ...STATUS, PUBLISHABLE_KEY: STATUS.ANON_KEY })).toThrow(
      /sb_publishable_/,
    );
    expect(() => supabaseStatusToEnv({ ...STATUS, SECRET_KEY: STATUS.SERVICE_ROLE_KEY })).toThrow(
      /sb_secret_/,
    );
  });

  it("localStackUrls reads studio + mailpit off the status and pins the rest", () => {
    expect(localStackUrls(STATUS)).toEqual({
      app: LOCAL_APP_URL,
      inngest: "http://127.0.0.1:8288",
      studio: STATUS.STUDIO_URL,
      mailpit: STATUS.MAILPIT_URL,
    });
  });
});

describe("generateLocalSecrets", () => {
  const secrets = generateLocalSecrets((n) => Buffer.alloc(n, 0xab));

  it("SECRETS_ENCRYPTION_KEY is 32 bytes base64 — the validateEncryptionKey rule", () => {
    expect(Buffer.from(secrets.SECRETS_ENCRYPTION_KEY, "base64")).toHaveLength(32);
  });

  it("neither value needs quoting or refusing by serializeEnvValue", () => {
    for (const v of Object.values(secrets)) {
      expect(v).not.toMatch(/[\s#'"$]/);
      expect(v.length).toBeGreaterThanOrEqual(40);
    }
  });
});

describe("buildLocalEnvValues", () => {
  const supabase = supabaseStatusToEnv(STATUS);
  const secrets = generateLocalSecrets((n) => Buffer.alloc(n, 1));

  it("pins durable Inngest routing, the 127.0.0.1 app URLs and the local Redis pair", () => {
    const v = buildLocalEnvValues({ supabase, secrets });
    expect(v.INNGEST_DEV).toBe("0");
    expect(v.INNGEST_BASE_URL).toBe("http://127.0.0.1:8288");
    expect(v.INNGEST_EVENT_KEY).toBe(secrets.INNGEST_EVENT_KEY);
    expect(v.INNGEST_SIGNING_KEY).toBe(secrets.INNGEST_SIGNING_KEY);
    expect(inngestModeFor(v)).toBe("server");
    expect(v.NEXT_PUBLIC_APP_URL).toBe(LOCAL_APP_URL);
    expect(v.LOCAL_CC_ENGINE_URL).toBe(LOCAL_APP_URL);
    expect(v.UPSTASH_REDIS_REST_URL).toBe(LOCAL_REDIS_REST_URL);
    expect(v.UPSTASH_REDIS_REST_TOKEN).toBe(LOCAL_REDIS_REST_TOKEN);
    expect(v.NEXT_PUBLIC_LOCAL_MAIL_URL).toBe(STATUS.MAILPIT_URL);
  });

  it("omits DEVPILOT_RUNNER_TENANT_ID when no tenant was bootstrapped", () => {
    expect("DEVPILOT_RUNNER_TENANT_ID" in buildLocalEnvValues({ supabase, secrets })).toBe(false);
    expect(
      buildLocalEnvValues({ supabase, secrets, tenantId: "t-1" }).DEVPILOT_RUNNER_TENANT_ID,
    ).toBe("t-1");
  });
});

describe("preflight predicates", () => {
  it("isLocalRedisUrl is a hostname comparison, never a prefix match", () => {
    expect(isLocalRedisUrl(LOCAL_REDIS_REST_URL)).toBe(true);
    expect(isLocalRedisUrl("http://localhost:8079")).toBe(true);
    expect(isLocalRedisUrl("https://usw1-x.upstash.io")).toBe(false);
    expect(isLocalRedisUrl("https://127.0.0.1.evil.example")).toBe(false);
    expect(isLocalRedisUrl("not a url")).toBe(false);
  });

  it("isPong", () => {
    expect(isPong({ result: "PONG" })).toBe(true);
    expect(isPong({ result: "pong" })).toBe(false);
    expect(isPong({ error: "unauthorized" })).toBe(false);
    expect(isPong(null)).toBe(false);
  });

  it("classifyClaudeAuth reads loggedIn and nothing else", () => {
    expect(classifyClaudeAuth('{"loggedIn":true,"subscriptionType":"pro"}')).toBe("logged-in");
    expect(classifyClaudeAuth('warning\n{"loggedIn":false}\n')).toBe("logged-out");
    expect(classifyClaudeAuth("")).toBe("unknown");
    expect(classifyClaudeAuth("{not json")).toBe("unknown");
    expect(classifyClaudeAuth('{"status":"ok"}')).toBe("unknown");
  });

  it("nodeMajor", () => {
    expect(nodeMajor("24.13.0")).toBe(24);
    expect(nodeMajor("20.0.0")).toBe(20);
    expect(nodeMajor("")).toBe(0);
  });
});

describe("compose drift — infra/local/docker-compose.yml matches the constants", () => {
  const compose = readFileSync(COMPOSE_PATH, "utf8");

  it("SRH_TOKEN equals LOCAL_REDIS_REST_TOKEN", () => {
    expect(compose).toMatch(new RegExp(`SRH_TOKEN:\\s*${LOCAL_REDIS_REST_TOKEN}\\s*$`, "m"));
  });

  it("publishes the REST port on loopback at LOCAL_REDIS_REST_URL's port", () => {
    const port = new URL(LOCAL_REDIS_REST_URL).port;
    expect(compose).toContain(`"127.0.0.1:${port}:80"`);
    expect(compose).not.toMatch(/"0\.0\.0\.0:/);
  });

  it("pins the shim image by digest, not `latest`", () => {
    expect(compose).toMatch(/serverless-redis-http@sha256:[0-9a-f]{64}/);
    expect(compose).not.toMatch(/serverless-redis-http:latest/);
  });
});

describe("what survives a restart", () => {
  it("runnerNameFor is a stable slug of the hostname, never empty", () => {
    expect(runnerNameFor("Singhs-MacBook.local")).toBe("local-cc-singhs-macbook.local");
    expect(runnerNameFor("my host (2)")).toBe("local-cc-my-host-2");
    expect(runnerNameFor("")).toBe("local-cc-local");
    expect(runnerNameFor("x".repeat(80)).length).toBeLessThanOrEqual("local-cc-".length + 40);
  });

  it("envBackupPath is outside the repo, keyed per clone", () => {
    const a = envBackupPath("/home/u", "/home/u/code/devpilot");
    const b = envBackupPath("/home/u", "/home/u/code/devpilot-2");
    expect(a.startsWith("/home/u/.devpilot/env-backups/")).toBe(true);
    expect(a.endsWith(".env.local")).toBe(true);
    expect(a).not.toBe(b);
    expect(envBackupPath("/home/u", "/home/u/code/devpilot")).toBe(a);
  });

  it("isInstallStale: no lockfile → fine; no install → stale; lockfile newer → stale", () => {
    expect(isInstallStale(null, null)).toBe(false);
    expect(isInstallStale(1000, null)).toBe(true);
    expect(isInstallStale(2000, 1000)).toBe(true);
    expect(isInstallStale(1000, 2000)).toBe(false);
  });

  it("buildLocalEnvValues carries the runner name when given", () => {
    const supabase = supabaseStatusToEnv(STATUS);
    const secrets = generateLocalSecrets((n) => Buffer.alloc(n, 1));
    expect(buildLocalEnvValues({ supabase, secrets }).DEVPILOT_RUNNER_NAME).toBeUndefined();
    expect(
      buildLocalEnvValues({ supabase, secrets, runnerName: "local-cc-x" }).DEVPILOT_RUNNER_NAME,
    ).toBe("local-cc-x");
  });

  it("dev-inngest.mjs decides the mode from .env.local and runs `inngest start` for durable mode", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../../scripts/dev-inngest.mjs", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("inngestModeFor(");
    expect(src).toContain("inngestServerSpec(");
    expect(src).toMatch(/\.devpilot",\s*"inngest"/);
    expect(src).toMatch(/cwd:\s*DATA_DIR/);
    // dev-server mode still exists for a hand-written env, with the honest caveat
    expect(src).toContain('"--persist"');
    expect(src).toMatch(/do NOT survive a restart/);
  });
});

describe("Supabase bring-up after a reboot", () => {
  it("classifies the db container from its docker status line", () => {
    expect(classifySupabaseContainer(null)).toBe("absent");
    expect(classifySupabaseContainer("")).toBe("absent");
    expect(classifySupabaseContainer("Up 6 minutes (healthy)")).toBe("running");
    expect(classifySupabaseContainer("Up 1 second (health: starting)")).toBe("running");
    expect(classifySupabaseContainer("Exited (255) 11 minutes ago")).toBe("stopped");
    expect(classifySupabaseContainer("Created")).toBe("stopped");
  });

  it("waits for containers Docker is already restarting; starts the rest", () => {
    expect(decideSupabaseBringUp("running")).toBe("wait-then-start");
    expect(decideSupabaseBringUp("stopped")).toBe("start");
    expect(decideSupabaseBringUp("absent")).toBe("start");
  });
});

describe("durable Inngest (self-hosted server) wiring", () => {
  it("inngestModeFor: server only with an explicit INNGEST_DEV=0 AND both keys", () => {
    const keys = { INNGEST_EVENT_KEY: "e", INNGEST_SIGNING_KEY: "signkey-prod-ab" };
    expect(inngestModeFor({ INNGEST_DEV: "0", ...keys })).toBe("server");
    expect(inngestModeFor({ INNGEST_DEV: "false", ...keys })).toBe("server");
    expect(inngestModeFor({ INNGEST_DEV: "1", ...keys })).toBe("dev");
    expect(inngestModeFor({ ...keys })).toBe("dev"); // unset → the SDK infers dev under next dev
    expect(inngestModeFor({ INNGEST_DEV: "0", INNGEST_EVENT_KEY: "e" })).toBe("dev");
    expect(
      inngestModeFor({ INNGEST_DEV: "0", INNGEST_EVENT_KEY: "", INNGEST_SIGNING_KEY: "" }),
    ).toBe("dev");
  });

  it("requiredLocalEnvKeysFor drops only the server-mode keys in dev mode", () => {
    const server = requiredLocalEnvKeysFor("server");
    const dev = requiredLocalEnvKeysFor("dev");
    expect(server).toEqual(REQUIRED_LOCAL_ENV_KEYS);
    expect(dev).not.toContain("INNGEST_EVENT_KEY");
    expect(dev).not.toContain("INNGEST_SIGNING_KEY");
    expect(dev).not.toContain("INNGEST_BASE_URL");
    expect(dev).toContain("INNGEST_DEV");
    expect(dev).toContain("DEVPILOT_RUNNER_TENANT_ID");
  });

  it("inngestServerSpec: argv carries no key; the env carries the hex-only signing key", () => {
    const spec = inngestServerSpec(
      { INNGEST_EVENT_KEY: " evk ", INNGEST_SIGNING_KEY: "signkey-prod-abcdef" },
      { dataDir: "/x/inngest" },
    );
    expect(spec.args.slice(0, 2)).toEqual(["start", "-u"]);
    expect(spec.args).toContain("/x/inngest");
    expect(spec.args).toContain(LOCAL_INNGEST_REDIS_URI);
    expect(spec.args.join(" ")).not.toContain("evk");
    expect(spec.args.join(" ")).not.toContain("abcdef");
    expect(spec.env).toEqual({ INNGEST_EVENT_KEY: "evk", INNGEST_SIGNING_KEY: "abcdef" });
  });

  it("stripSigningKeyPrefix leaves an unprefixed key alone", () => {
    expect(stripSigningKeyPrefix("signkey-test-00ff")).toBe("00ff");
    expect(stripSigningKeyPrefix("00ff")).toBe("00ff");
  });

  it("generateLocalSecrets: Inngest keys are hex, and the SDK form carries the prefix", () => {
    const s = generateLocalSecrets((n) => Buffer.alloc(n, 0x5a));
    expect(s.INNGEST_EVENT_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(s.INNGEST_SIGNING_KEY).toMatch(/^signkey-prod-[0-9a-f]{64}$/);
    expect(stripSigningKeyPrefix(s.INNGEST_SIGNING_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the compose file publishes the Inngest state Redis on the loopback port the URI names", () => {
    const port = new URL(LOCAL_INNGEST_REDIS_URI).port;
    expect(readFileSync(COMPOSE_PATH, "utf8")).toContain(`"127.0.0.1:${port}:6379"`);
  });
});

describe("GitHub OAuth app wiring", () => {
  it("the two supabase/.env lines and the two .env.local lines, trimmed", () => {
    const app = { clientId: " Iv1.abc ", clientSecret: " s3cret " };
    expect(buildSupabaseDotenvValues(app)).toEqual({
      SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID: "Iv1.abc",
      SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET: "s3cret",
    });
    expect(buildGithubEnvValues(app)).toEqual({
      GITHUB_OAUTH_CLIENT_ID: "Iv1.abc",
      GITHUB_OAUTH_CLIENT_SECRET: "s3cret",
    });
  });

  it("the callback is the LOCAL GoTrue, and the how-to names it plus the exact command", () => {
    expect(githubCallbackUrl("http://127.0.0.1:54321/")).toBe(
      "http://127.0.0.1:54321/auth/v1/callback",
    );
    const text = githubOauthHowto("http://127.0.0.1:54321", LOCAL_APP_URL).join("\n");
    expect(text).toContain("http://127.0.0.1:54321/auth/v1/callback");
    expect(text).toContain("--github-client-id");
    expect(text).toContain("https://github.com/settings/developers");
  });

  it("config.toml enables the provider and reads BOTH values from env()", () => {
    const toml = readFileSync(
      fileURLToPath(new URL("../../../../../supabase/config.toml", import.meta.url)),
      "utf8",
    );
    const block = toml.slice(toml.indexOf("[auth.external.github]"));
    expect(block).toMatch(/^enabled = true$/m);
    for (const key of SUPABASE_DOTENV_GITHUB_KEYS) expect(block).toContain(`env(${key})`);
  });
});
