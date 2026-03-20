// Server-only resolver for the per-tenant LLM auth-mode. Single source of truth
// that everything reads: the runner bridge's `decidePolicy`, the runner-mode
// onboarding detector, and the system-health LLM probe.
//
// Storage: `tenants.config` jsonb (the same bag M14 uses for
// `config.default_agent_id`) — no new table for a single knob, and it stays
// per-tenant like the token/API-key resolution it drives. An absent field
// resolves to `claude_code` (see `normalizeLlmAuthMode`) so a fresh install is
// Claude Code auth with zero config.
//
// Read fresh from Postgres each call (service-role, no RLS dependency) — this is
// low-frequency (once per plan turn / once per health snapshot), not a hot path,
// and staying uncached avoids a second cache to invalidate on write.

import "server-only";

import { supabaseService } from "@/lib/db/server";
import {
  LLM_AUTH_MODE_CONFIG_KEY,
  DEFAULT_LLM_AUTH_MODE,
  normalizeLlmAuthMode,
  type LlmAuthMode,
} from "./auth-mode";

/** Resolve the tenant's LLM auth-mode. `null` tenant (instance scope, or an
 *  unauthenticated probe) resolves to the default. Any DB error is swallowed to
 *  the default so a transient Supabase blip never flips the platform off its
 *  Claude Code default. */
export async function getLlmAuthMode(tenantId: string | null): Promise<LlmAuthMode> {
  if (!tenantId) return DEFAULT_LLM_AUTH_MODE;
  try {
    const { data, error } = await supabaseService()
      .from("tenants")
      .select("config")
      .eq("id", tenantId)
      .maybeSingle();
    if (error || !data) return DEFAULT_LLM_AUTH_MODE;
    const cfg = (data.config ?? {}) as Record<string, unknown>;
    return normalizeLlmAuthMode(cfg[LLM_AUTH_MODE_CONFIG_KEY]);
  } catch {
    return DEFAULT_LLM_AUTH_MODE;
  }
}
