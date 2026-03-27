// The stale-credential fix, proven against a REAL git binary.
//
// Every claim this feature rests on is a claim about git's behaviour, not about
// our code shape: that a userinfo segment in the remote URL beats every
// credential helper, that an empty `credential.helper` discards inherited ones,
// and that `GIT_CONFIG_*` leaves nothing on disk. A test with a mocked `spawn`
// would assert our beliefs about git rather than git. So these drive the real
// thing in a temp repo.

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gitCredentialEnv, stripUrlCredentials, GIT_TOKEN_ENV_VAR } from "@/lib/git/credentials";
import { gitExec, safeStderr } from "@/lib/git/exec";
import { ensureCredentialFreeOrigin } from "@/lib/git/remote";

const FRESH_TOKEN = "ghs_freshTokenFromTheDatabase";
const STALE_TOKEN = "ghs_staleTokenFrozenIntoTheClone";

let repo: string;

/** `git credential fill` — needs stdin, which `gitExec` deliberately closes. */
function credentialFill(
  cwd: string,
  env: NodeJS.ProcessEnv,
  request: string,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential", "fill"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.end(request);
  });
}

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "devpilot-cred-"));
  await gitExec(repo, ["init", "-q"], 15_000);
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("stripUrlCredentials", () => {
  it("removes the userinfo segment from a tokenised https remote", () => {
    expect(
      stripUrlCredentials(`https://x-access-token:${STALE_TOKEN}@github.com/acme/widgets.git`),
    ).toBe("https://github.com/acme/widgets.git");
  });

  it("returns null — leave it alone — for a URL that carries no credential", () => {
    expect(stripUrlCredentials("https://github.com/acme/widgets.git")).toBeNull();
  });

  it("returns null for an ssh remote, which has no inline credential to strip", () => {
    expect(stripUrlCredentials("git@github.com:acme/widgets.git")).toBeNull();
  });

  it("returns null for an unparseable URL rather than throwing", () => {
    expect(stripUrlCredentials("https://")).toBeNull();
  });
});

describe("gitCredentialEnv", () => {
  it("never places the token in a config VALUE — only in its own variable", () => {
    const env = gitCredentialEnv(FRESH_TOKEN);
    for (const [key, value] of Object.entries(env)) {
      if (key === GIT_TOKEN_ENV_VAR) continue;
      expect(value).not.toContain(FRESH_TOKEN);
    }
    expect(env[GIT_TOKEN_ENV_VAR]).toBe(FRESH_TOKEN);
  });

  it("resets inherited helpers before installing its own", () => {
    const env = gitCredentialEnv(FRESH_TOKEN);
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    // The empty value is what discards a globally-configured helper such as
    // osxkeychain, which would otherwise answer first with a stale credential.
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_1).toContain("username=x-access-token");
  });

  it("supplies the FRESH token to git even when a stale helper is configured first", async () => {
    // A helper that hands back the old credential, exactly as a machine
    // keychain or an inherited config would.
    const staleHelper = `!f() { test "$1" = get && printf 'username=stale\\npassword=${STALE_TOKEN}\\n'; }; f`;
    const { stdout } = await credentialFill(
      repo,
      {
        ...process.env,
        // Entry 0 is the stale helper; `gitCredentialEnv` must override the
        // whole list, not append to it.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: staleHelper,
        ...gitCredentialEnv(FRESH_TOKEN),
      },
      "protocol=https\nhost=github.com\n\n",
    );
    expect(stdout).toContain(`password=${FRESH_TOKEN}`);
    expect(stdout).not.toContain(STALE_TOKEN);
  });

  it("leaves nothing behind on disk — the credential lives only in the env", async () => {
    await gitExec(repo, ["config", "--get-all", "credential.helper"], 15_000, {
      token: FRESH_TOKEN,
    }).catch(() => undefined);

    const config = await readFile(path.join(repo, ".git", "config"), "utf8");
    expect(config).not.toContain(FRESH_TOKEN);
    expect(config).not.toContain("credential.helper");
  });
});

describe("ensureCredentialFreeOrigin", () => {
  it("strips a token baked into the workspace's origin URL", async () => {
    await gitExec(
      repo,
      ["remote", "add", "origin", `https://x-access-token:${STALE_TOKEN}@github.com/acme/w.git`],
      15_000,
    );

    // Precondition — without this the assertion below could pass vacuously.
    const before = await readFile(path.join(repo, ".git", "config"), "utf8");
    expect(before).toContain(STALE_TOKEN);

    const result = await ensureCredentialFreeOrigin(repo);
    expect(result).toEqual({ kind: "stripped", url: "https://github.com/acme/w.git" });

    const after = await readFile(path.join(repo, ".git", "config"), "utf8");
    expect(after).not.toContain(STALE_TOKEN);
    expect(after).toContain("https://github.com/acme/w.git");
  });

  it("is idempotent — a clean remote is left untouched", async () => {
    const result = await ensureCredentialFreeOrigin(repo);
    expect(result).toEqual({ kind: "already_clean" });
  });

  it("reports unavailable rather than throwing when there is no origin", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "devpilot-cred-noremote-"));
    try {
      await gitExec(bare, ["init", "-q"], 15_000);
      const result = await ensureCredentialFreeOrigin(bare);
      expect(result.kind).toBe("unavailable");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("the token never reaches a log line or an error message", () => {
  it("scrubs a literal token needle out of stderr", () => {
    expect(safeStderr(`remote: Bad credentials for ${FRESH_TOKEN}`, FRESH_TOKEN)).toBe(
      "remote: Bad credentials for ***",
    );
  });

  it("still scrubs a credential-bearing URL when no needle is supplied", () => {
    expect(
      safeStderr(`fatal: https://x-access-token:${STALE_TOKEN}@github.com/a/b.git failed`),
    ).toBe("fatal: https://***@github.com/a/b.git failed");
  });

  it("ignores a needle too short to be a credential", () => {
    // A three-character needle would shred unrelated text; a credential is
    // never that short.
    expect(safeStderr("the cat sat on the mat", "cat")).toBe("the cat sat on the mat");
  });

  it("keeps the token out of a REAL failing git invocation's error", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "devpilot-cred-fail-"));
    try {
      await gitExec(scratch, ["init", "-q"], 15_000);
      // A remote that cannot resolve: git fails and echoes the URL back.
      await gitExec(
        scratch,
        [
          "remote",
          "add",
          "origin",
          `https://x-access-token:${STALE_TOKEN}@invalid.devpilot.test/a/b.git`,
        ],
        15_000,
      );

      let message = "";
      try {
        await gitExec(scratch, ["fetch", "origin", "main"], 30_000, { token: FRESH_TOKEN });
        throw new Error("expected the fetch to fail");
      } catch (err) {
        message = (err as Error).message;
      }

      expect(message).not.toContain(FRESH_TOKEN);
      expect(message).not.toContain(STALE_TOKEN);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 40_000);
});
