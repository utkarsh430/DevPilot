import "server-only";

// Server-only resolver for the per-tenant learning auto-approve THRESHOLD. Read
// by the single extractor insert seam (`extract-batch.ts` via
// `defaultExtractDeps`) to decide whether a freshly graded candidate lands
// `active` or `candidate`.
//
// Storage: `tenants.config` jsonb — the same bag `llm_auth_mode` lives in, so no
// migration is needed for this knob (and none was needed for the boolean →
// threshold widening either: the same key now holds either shape and
// `normalizeLearningAutoApproveThreshold` reads both, mapping a legacy `true` to
// the STRICTER `'high_only'`). Read fresh from Postgres each call (service-role,
// no RLS dependency); extraction is already an async, low-frequency path, and
// staying uncached avoids a second cache to invalidate on the setter write. Any
// DB error swallows to `'off'` (keep the review gate on), so a transient Supabase
// blip never silently auto-approves.

import { supabaseService } from "@/lib/db/server";
import {
  DEFAULT_LEARNING_AUTO_APPROVE_THRESHOLD,
  isAutoApproveEnabled,
  LEARNING_AUTO_APPROVE_CONFIG_KEY,
  normalizeLearningAutoApproveThreshold,
  type LearningAutoApproveThreshold,
} from "./auto-approve";

/** Resolve the tenant's learning auto-approve threshold. A `null` tenant (no
 *  session / ticket-less path) resolves to the default. Any DB error is swallowed
 *  to the default so a blip can never flip the platform into unreviewed
 *  auto-approval. */
export async function getLearningAutoApproveThreshold(
  tenantId: string | null,
): Promise<LearningAutoApproveThreshold> {
  if (!tenantId) return DEFAULT_LEARNING_AUTO_APPROVE_THRESHOLD;
  try {
    const { data, error } = await supabaseService()
      .from("tenants")
      .select("config")
      .eq("id", tenantId)
      .maybeSingle();
    if (error || !data) return DEFAULT_LEARNING_AUTO_APPROVE_THRESHOLD;
    const cfg = (data.config ?? {}) as Record<string, unknown>;
    return normalizeLearningAutoApproveThreshold(cfg[LEARNING_AUTO_APPROVE_CONFIG_KEY]);
  } catch {
    return DEFAULT_LEARNING_AUTO_APPROVE_THRESHOLD;
  }
}

/** Legacy boolean view, for surfaces still rendering a simple on/off toggle.
 *  Prefer `getLearningAutoApproveThreshold` in new code. */
export async function getLearningAutoApprove(tenantId: string | null): Promise<boolean> {
  return isAutoApproveEnabled(await getLearningAutoApproveThreshold(tenantId));
}
