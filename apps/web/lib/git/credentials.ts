// Ephemeral GitHub credentials for a git subprocess.
//
// THE BUG THIS EXISTS TO END. A workspace's `origin` remote used to carry the
// credential inside the URL (`https://x-access-token:<token>@github.com/…`),
// written once when the workspace was created. Git prefers a full userinfo
// segment over every credential helper, so every later push authenticated with
// that frozen token no matter what the database said. Reconnecting GitHub,
// rotating the token, or granting a new scope reached NO existing workspace —
// and the resulting rejection names the very token you just fixed, which is a
// trail that costs hours.
//
// The fix has two halves and both are load-bearing:
//
//   1. STRIP the credential out of the persisted remote URL (`remote.ts`), so
//      nothing on disk can win over — or outlive — the resolved credential. A
//      revoked token embedded in `.git/config` is readable by anything with
//      filesystem access and keeps being presented until the workspace is
//      recreated; removing it is the security half of this change.
//
//   2. SUPPLY the freshly resolved token for the DURATION OF THE PUSH ONLY,
//      via the environment of that one subprocess. Nothing is written to
//      `.git/config`, so nothing is left behind when the process exits.
//
// WHY THE ENVIRONMENT AND NOT ARGV. `git -c credential.helper=…` would put the
// helper on the command line, and a token passed as `https://<token>@…` on the
// command line is visible in `ps` to every user on the host. `GIT_CONFIG_COUNT`
// / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` is git's documented way to supply
// configuration for exactly one invocation, and a process environment is not
// world-readable on the platforms we run on. The token itself never appears in
// a config value either — the helper reads it from its own environment by name,
// so even a git version that logged its effective config would print the
// variable's NAME, not its contents.
//
// WHY THE EMPTY HELPER ENTRY IS REQUIRED. Credential helpers are a LIST, tried
// in order, and the operator's machine very often has one installed globally
// (`osxkeychain` on every macOS dev box). Without a reset, the keychain answers
// first and can hand back exactly the stale credential this module exists to
// stop using. Git treats an EMPTY `credential.helper` value as "discard every
// helper configured so far", so entry 0 clears the inherited list and entry 1
// installs ours as the only one. Verified against git 2.54: with a deliberately
// wrong helper ahead of the reset, `git credential fill` still returns ours.

/**
 * Name of the environment variable the credential helper reads the token from.
 *
 * Deliberately NOT a well-known name: it is set only on the git subprocess we
 * spawn, and naming it after this product makes it obvious in a process listing
 * that the variable is ours (the listing shows names, never values).
 */
export const GIT_TOKEN_ENV_VAR = "DEVPILOT_GIT_TOKEN";

/**
 * The credential helper itself, as a git config value.
 *
 * A leading `!` makes git run the string through `/bin/sh`. It is a FIXED
 * string — no interpolation of any kind — so there is nothing here for a
 * caller-supplied value to escape into. The token is read from the environment
 * at helper-run time.
 *
 * Only the `get` operation answers. `store` and `erase` are deliberately silent
 * no-ops: `store` is what would write the credential somewhere persistent, and
 * that is precisely the behaviour this module exists to avoid.
 */
const CREDENTIAL_HELPER = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${GIT_TOKEN_ENV_VAR}"; }; f`;

/**
 * Environment additions that make one git subprocess authenticate with `token`.
 *
 * Merge over `process.env` — these keys overwrite whatever the host had, which
 * is intentional: an inherited `GIT_CONFIG_COUNT` from an outer process would
 * otherwise silently renumber (and so disable) our entries.
 */
export function gitCredentialEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
    [GIT_TOKEN_ENV_VAR]: token,
    // Belt and braces: with no helper able to answer (a token that is empty at
    // the point of use), git must fail rather than block the worker on a
    // terminal prompt that will never be answered.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
  };
}

/**
 * Remove any credential from an https remote URL, returning the cleaned form.
 *
 * Returns `null` when there is nothing to do — the URL is unparseable, is not
 * https (an SSH remote carries no inline credential), or already has no
 * userinfo. A `null` therefore means "leave the remote alone", never "the URL
 * was bad": callers must not treat it as an error.
 */
export function stripUrlCredentials(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.username === "" && parsed.password === "") return null;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}
