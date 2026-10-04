// Pure types shared by the setup validators (server), the setup API routes,
// and the wizard client components. Keep this file free of server-only
// imports — it crosses the client boundary.

/**
 * Tri-state credential check result.
 *  - "valid"      — the credential was positively verified against the service.
 *  - "invalid"    — the service positively rejected it (wrong key, bad URL).
 *  - "unverified" — we couldn't tell (network blip, unknown response shape).
 *                   Saves proceed with a warning; never a false block.
 */
export type ValidationState = "valid" | "invalid" | "unverified";

export type ValidationResult = {
  state: ValidationState;
  /** One-line, operator-facing outcome ("Connected as acme-corp", "401 — wrong key"). */
  message: string;
};

export const unverified = (message: string): ValidationResult => ({
  state: "unverified",
  message,
});
export const valid = (message: string): ValidationResult => ({ state: "valid", message });
export const invalid = (message: string): ValidationResult => ({ state: "invalid", message });
