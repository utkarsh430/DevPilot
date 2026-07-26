// The `operatorOnly` write gate — the decision half, dependency-injected so it
// is unit-testable.
//
// WHY THIS IS A SEPARATE MODULE. The rule has to be provable by a test that
// actually REFUSES a non-operator, not one that merely asserts the catalog flag
// exists. The server actions live in `app/(app)/settings/platform-secrets/`,
// are `"use server"`, and pull in `@/lib/auth` → `next/headers`, so they cannot
// load under Vitest at all. Keeping the decision here — with the operator
// lookup injected — is what makes the refusal itself testable rather than the
// paperwork around it. Same split as `lib/learning/write.ts` vs its action
// wrapper.
//
// The gate is deliberately shaped as "return a message or null" rather than a
// boolean: every caller is an action returning `{ok:false, error}`, and a
// boolean invites a caller to invent its own (weaker, or leakier) wording.

import { platformCatalogEntry } from "@/lib/platform-secrets/catalog";

/** Resolves whether a user holds the instance-operator role. Injected so tests
 *  never touch the DB — in production this is `isInstanceOperator`. */
export type OperatorCheck = (userId: string) => Promise<boolean>;

/**
 * Refusal message for an `operatorOnly` key written by a non-operator, or null
 * when the write may proceed.
 *
 * FAIL CLOSED. An unknown key returns null here on purpose — the callers run
 * `assertEditable` / `assertInstanceScoped` first, and those already reject an
 * unrecognized key with a better message. This function's only job is the role
 * check, and duplicating the catalog-membership check would put two different
 * "unknown key" errors on one path.
 *
 * A throwing operator check is treated as NOT an operator: the underlying
 * `isInstanceOperator` already swallows its own errors and returns false, but a
 * gate that let an exception through as an allow would invert the whole control.
 */
export async function operatorOnlyRefusal(
  secretKey: string,
  userId: string,
  isOperator: OperatorCheck,
): Promise<string | null> {
  const entry = platformCatalogEntry(secretKey);
  if (!entry?.operatorOnly) return null;
  let allowed = false;
  try {
    allowed = await isOperator(userId);
  } catch {
    allowed = false;
  }
  if (allowed) return null;
  return `${secretKey} can only be changed by an instance operator`;
}

/** Catalog keys carrying the flag. Exported for the settings UI, which disables
 *  the editor for a non-operator rather than letting them type a value and get
 *  a refusal on save. */
export function isOperatorOnlyKey(secretKey: string): boolean {
  return platformCatalogEntry(secretKey)?.operatorOnly === true;
}
