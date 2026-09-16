// One-time setup token (server-only). The boot /setup surface is pre-auth by
// definition (no Supabase ⇒ no users), so the write/validate API is gated
// Jupyter-style: a random token printed to the SERVER console at boot. Being
// able to read it proves shell access to the host — the same trust level as
// editing .env.local by hand.
//
// The token lives on `globalThis` so dev-server recompiles reuse one value per
// process, and it is only ever CREATED while the instance is unconfigured —
// once boot env exists the routes 403 before consulting it.

import "server-only";

// WebCrypto (global in Node ≥ 19 and on the edge runtime) instead of
// node:crypto — instrumentation.ts is bundled for BOTH runtimes and webpack
// refuses `node:` schemes in the edge pass even behind a NEXT_RUNTIME guard.

function randomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

type SetupGlobals = {
  __devpilotSetupToken?: string;
  __devpilotSetupBannerPrinted?: boolean;
};

const g = globalThis as SetupGlobals;

export function getOrCreateSetupToken(): string {
  if (!g.__devpilotSetupToken) {
    g.__devpilotSetupToken = randomToken();
  }
  return g.__devpilotSetupToken;
}

export function verifySetupToken(provided: string | null | undefined): boolean {
  const expected = g.__devpilotSetupToken;
  if (!expected || !provided) return false;
  return constantTimeEqual(provided, expected);
}

/** Print the first-run banner (token + URL) once per process. Safe to call on
 *  every status poll — subsequent calls are no-ops. */
export function printSetupBannerOnce(): void {
  if (g.__devpilotSetupBannerPrinted) return;
  g.__devpilotSetupBannerPrinted = true;
  const token = getOrCreateSetupToken();
  const base = process.env.NEXT_PUBLIC_APP_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`;
  const url = `${base}/setup`;
  console.log(
    [
      "",
      "┌──────────────────────────────────────────────────────────────────────┐",
      "│  DevPilot is not configured yet.                                      │",
      "│                                                                      │",
      "│  Open the setup wizard and unlock it with this one-time token:      │",
      "│                                                                      │",
      `│    ${url}`,
      `│    token: ${token}`,
      "│                                                                      │",
      "│  The token proves shell access to this host. It is regenerated on   │",
      "│  every restart and stops working the moment setup completes.        │",
      "└──────────────────────────────────────────────────────────────────────┘",
      "",
    ].join("\n"),
  );
}
