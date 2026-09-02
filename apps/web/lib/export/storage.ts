// Export storage constants + the object-path derivation. PURE.
//
// Split out of the routes/worker for the same reason `lib/board/attachments.ts`
// is split out of its callers: the path shape is a SECURITY rule (the bucket's
// RLS keys on the first segment being the tenant), so it belongs in one
// unit-testable place that every writer and reader agrees on, rather than being
// re-templated at each call site.

/** The private bucket declared in `supabase/config.toml` and the prod migration. */
export const EXPORTS_BUCKET = "exports";

/**
 * Signed-URL lifetime for a download. Matches the attachments route's
 * `SIGNED_URL_TTL_SECONDS` pattern: short, because the client redeems it
 * immediately, and a leaked link should expire fast.
 */
export const SIGNED_URL_TTL_SECONDS = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `"<tenantId>/<exportId>.pdf"` — the object path for a rendered export.
 *
 * BOTH segments are validated uuids, so the path can never be steered with
 * attacker-controlled text, and the FIRST segment is always the tenant, which is
 * what the bucket RLS (`(storage.foldername(name))[1] in current_user_tenants()`)
 * matches on. Throws rather than returning null: every caller here has already
 * read both ids out of a DB row, so a non-uuid means something is deeply wrong
 * upstream and must not be papered over with a fallback path.
 */
export function exportStorageKey(tenantId: string, exportId: string): string {
  if (!UUID_RE.test(tenantId)) throw new Error("export: invalid tenant id for storage key");
  if (!UUID_RE.test(exportId)) throw new Error("export: invalid export id for storage key");
  return `${tenantId}/${exportId}.pdf`;
}

/**
 * The boundary check mirroring the bucket RLS: an export object is readable only
 * when its key's first path segment is EXACTLY the caller's tenant. The download
 * route re-checks the STORED key against the session's tenant before signing, so
 * a stray/corrupted row can never be turned into a cross-tenant signed URL.
 */
export function isExportKeyUnderTenant(storageKey: string, tenantId: string): boolean {
  if (!UUID_RE.test(tenantId)) return false;
  const firstSlash = storageKey.indexOf("/");
  if (firstSlash <= 0) return false;
  return storageKey.slice(0, firstSlash) === tenantId;
}
