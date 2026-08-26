// Boot-minimum configuration status (server-only). "Boot" = the env vars the
// app cannot serve a single request without: the Supabase triplet. They are the
// chicken-and-egg set that can never live in the database — everything else can
// be configured post-auth from Settings → Setup.
//
// SECRETS_ENCRYPTION_KEY rides along in the boot wizard (it gates every
// platform-secrets write, and first-run is the natural moment to mint it), but
// it does NOT gate `isBootConfigured()` — the app serves fine without it.
//
// NOTE: middleware does NOT import this file (edge bundle); it repeats the
// same two public-var checks inline. Keep the two in sync.

import "server-only";

/** Missing any of these ⇒ every request crashes ⇒ the middleware routes to /setup. */
export const BOOT_REQUIRED_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;

/** Wanted at first run but non-fatal when absent. */
export const BOOT_RECOMMENDED_KEYS = ["SECRETS_ENCRYPTION_KEY"] as const;

export type BootEnvKey =
  | (typeof BOOT_REQUIRED_KEYS)[number]
  | (typeof BOOT_RECOMMENDED_KEYS)[number];

export const BOOT_ENV_KEYS: readonly BootEnvKey[] = [
  ...BOOT_REQUIRED_KEYS,
  ...BOOT_RECOMMENDED_KEYS,
];

function present(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

export function isBootConfigured(): boolean {
  return BOOT_REQUIRED_KEYS.every(present);
}

/** Which boot keys are set (booleans only — values never leave the server). */
export function bootEnvPresence(): Record<BootEnvKey, boolean> {
  const out = {} as Record<BootEnvKey, boolean>;
  for (const k of BOOT_ENV_KEYS) out[k] = present(k);
  return out;
}
