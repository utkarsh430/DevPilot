// Shared git subprocess helper.
//
// Extracted from `app/(app)/changes/actions.ts` when the WI-4 land worker needed
// the same rebase machinery: a `"use server"` module may only export async
// server actions, so the helpers could not simply be imported out of it.
//
// Hard rules, unchanged from the original (see the header of changes/actions.ts):
//   • `spawn` with explicit argv — never `exec` / `shell: true`, never string
//     interpolation into a shell command.
//   • stderr is scrubbed before it goes anywhere a human or an agent can read
//     it: the workspace's `origin` URL embeds a GitHub token in its userinfo
//     segment, and git prints the remote URL in plenty of error paths.

import { spawn } from "node:child_process";

import { gitCredentialEnv } from "./credentials";

export type GitExecOptions = {
  /**
   * A freshly resolved GitHub token to authenticate this ONE invocation with.
   *
   * Supplied through the subprocess environment (see `lib/git/credentials.ts`)
   * — never on the command line, where `ps` would expose it, and never written
   * to `.git/config`, where it would outlive the push and go stale. Omit it for
   * calls that do not talk to a remote.
   */
  token?: string | null;
};

/**
 * Run a git subcommand inside `cwd`. Resolves with stdout/stderr on exit 0;
 * rejects with an Error whose message has been through `safeStderr`.
 */
export function gitExec(
  cwd: string,
  args: string[],
  timeoutMs: number,
  options: GitExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const token = options.token ?? null;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(token ? gitCredentialEnv(token) : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(new Error(`git ${args[0]} exited with code ${code}: ${safeStderr(stderr, token)}`));
    });
  });
}

/**
 * Scrub anything that looks like a credential-bearing URL out of stderr so an
 * error message bubbled to a client — or into an agent's prompt — never carries
 * the operator's GitHub token.
 *
 * `token`, when supplied, is scrubbed as a LITERAL needle as well. The URL
 * patterns below only catch a credential sitting in a userinfo segment, and a
 * remote can echo a token back in prose ("Bad credentials: ghs_…"): a needle is
 * the only thing that catches that shape. Short values are ignored — a needle
 * of a handful of characters would mangle unrelated text into uselessness, and
 * a credential that short is not a credential.
 */
export function safeStderr(stderr: string, token?: string | null): string {
  let out = stderr
    .replace(/https:\/\/[^\s@]+@github\.com/g, "https://***@github.com")
    .replace(/https:\/\/[^\s@]+@/g, "https://***@");
  if (token && token.length >= 8) out = out.split(token).join("***");
  return out.trim();
}
