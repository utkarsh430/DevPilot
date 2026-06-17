// Fetch a single file from a GitHub repo over `raw.githubusercontent.com`.
//
// Extracted from `lib/plan/inngest.ts` (where it was `fetchRawFile`) so the
// plan-context loader and the WI-15 stack-tag detector share ONE
// implementation rather than growing a second, subtly different fetcher.
//
// The zero-SSRF property is the whole point and must not be diluted: the host
// is a FIXED literal here. No caller — not the repo, not the operator, not a
// stored column — may supply a base URL. Everything variable (owner, repo,
// branch) is percent-encoded into the path. If you ever need a GHE deployment,
// add an env-configured host at THIS layer, never a caller-supplied one.
//
// Everything else is best-effort by design: a 404 / timeout / network error is
// a `null`, never a throw. Both callers treat a missing file as "no signal".

/** Hard ceiling on what we will pull down at all. Lockfiles can be many MB. */
const MAX_DOWNLOAD_BYTES = 2_000_000;

const TIMEOUT_MS = 5_000;

export async function fetchRawFile(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  path: string,
  /** Cap the returned string. The caller parses this, so it bounds parse cost too. */
  maxBytes?: number,
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "devpilot" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    // Bail before reading the body when the server tells us it's enormous —
    // slicing after `.text()` would still have paid to download the whole thing.
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return null;
    const text = await res.text();
    return maxBytes === undefined ? text : text.slice(0, maxBytes);
  } catch {
    return null;
  }
}
