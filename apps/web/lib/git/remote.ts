// Keep a workspace's `origin` remote credential-free.
//
// The companion to `lib/git/credentials.ts`: that module supplies a freshly
// resolved token for the duration of one subprocess, and this one removes the
// STALE credential that would otherwise win over it. Git prefers a full
// userinfo segment in the remote URL over every credential helper, so leaving
// the old one in place makes the ephemeral credential unreachable — the two
// halves only work together.
//
// This is the one place in the web app that writes `remote.origin.url`, and it
// only ever writes a URL with NO credential in it. Nothing here can put a token
// back on disk.

import { gitExec } from "./exec";
import { stripUrlCredentials } from "./credentials";

const CONFIG_TIMEOUT_MS = 15_000;

export type OriginSanitizeResult =
  /** The remote carried a credential and no longer does. */
  | { kind: "stripped"; url: string }
  /** Nothing to do: no userinfo, a non-https remote, or an unparseable URL. */
  | { kind: "already_clean" }
  /** No `origin` remote, or git could not be asked. Callers proceed regardless. */
  | { kind: "unavailable"; reason: string };

/**
 * Remove any embedded credential from the workspace's `origin` URL.
 *
 * Call this immediately before any authenticated remote operation. It is
 * idempotent, cheap (two git config reads/writes at worst), and deliberately
 * NON-FATAL: a workspace whose remote cannot be read is a workspace whose push
 * is about to fail anyway with a far more specific message, and turning a
 * config hiccup into a landing failure would trade a good error for a bad one.
 *
 * The result is returned rather than logged here so the caller decides what is
 * worth recording — but note that `url` is safe to log by construction: it is
 * the value AFTER stripping, so it holds no credential.
 */
export async function ensureCredentialFreeOrigin(
  workspacePath: string,
): Promise<OriginSanitizeResult> {
  let current: string;
  try {
    const res = await gitExec(
      workspacePath,
      ["config", "--get", "remote.origin.url"],
      CONFIG_TIMEOUT_MS,
    );
    current = res.stdout.trim();
  } catch (err) {
    // Exit 1 from `config --get` simply means the key is unset. Either way
    // there is no credential of ours to remove.
    return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!current) return { kind: "unavailable", reason: "origin has no URL" };

  const cleaned = stripUrlCredentials(current);
  if (!cleaned) return { kind: "already_clean" };

  try {
    await gitExec(workspacePath, ["remote", "set-url", "origin", cleaned], CONFIG_TIMEOUT_MS);
  } catch (err) {
    return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
  return { kind: "stripped", url: cleaned };
}
