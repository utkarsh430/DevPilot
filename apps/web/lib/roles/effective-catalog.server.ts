import "server-only";

// Phase 2 / F3 — Effective role catalog (server-only loader).
//
// Joins the static built-in `ROLE_CATALOG` (50 hand-authored roles in
// `lib/roles/catalog.ts`) with any custom agents the tenant has materialized
// (JD-synth + visual builder writes into the `agents` table). The result is
// the union the operator-facing role picker shows in the New Ticket dialog.
//
// Why the split with `effective-catalog.ts`:
//
//  - The grouping helper + types are imported by `role-select.tsx`
//    (a `"use client"` component). If they shared a module with this loader,
//    webpack would drag `lib/db/server` (and `next/headers`) into the client
//    bundle and Next.js would refuse to build.
//  - The `"server-only"` shim at the top is a Next.js belt-and-suspenders
//    that throws at import time if a client module ever pulls this in.

import {
  BUILTIN_EFFECTIVE_CATALOG,
  CUSTOM_CATEGORY,
  type EffectiveCatalogEntry,
} from "@/lib/roles/effective-catalog";
import { supabaseService } from "@/lib/db/server";

// What we ask Postgres for. The agents schema (see
// `supabase/migrations/20260601000000_core.sql`) carries the slug on `role`,
// the operator-facing label on `name`, and the synth prompt + run policy under
// `config.role_config.*`. There is no top-level `description` column, so we
// pull the closest equivalent (the JD-synth display name + system prompt
// preamble) out of `config` defensively.
type AgentRow = {
  id: string;
  name: string | null;
  role: string | null;
  config: Record<string, unknown> | null;
};

type RoleConfigShape = {
  displayName?: unknown;
  systemPrompt?: unknown;
};

/**
 * Build the effective catalog visible to a single tenant's role picker.
 *
 * Failure mode: if the agents query errors (network, RLS misconfig, schema
 * drift…) we log a single warning and return the built-in catalog. The picker
 * never crashes — operators just don't see their custom roles until the read
 * recovers. Mirrors the engine's general "degrade, never block dispatch"
 * stance for read-path failures.
 */
export async function loadEffectiveCatalog(tenantId: string): Promise<EffectiveCatalogEntry[]> {
  const builtins: EffectiveCatalogEntry[] = [...BUILTIN_EFFECTIVE_CATALOG];
  const builtinSlugs = new Set(builtins.map((e) => e.slug));

  let rows: AgentRow[] = [];
  try {
    const supabase = supabaseService();
    const { data, error } = await supabase
      .from("agents")
      .select("id, name, role, config")
      .eq("tenant_id", tenantId);
    if (error) {
      console.warn(
        `[effective-catalog] agents query failed for tenant=${tenantId}: ${error.message}; returning built-ins only`,
      );
      return builtins;
    }
    rows = (data ?? []) as AgentRow[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[effective-catalog] agents query threw for tenant=${tenantId}: ${msg}; returning built-ins only`,
    );
    return builtins;
  }

  // Build the customs list:
  //  - drop rows whose slug already maps to a built-in. The built-in entry is
  //    the canonical display surface, AND the built-in CONFIG is what actually
  //    runs: `dispatcherFn` calls `getBuiltinRoleConfig(slug)` first and only
  //    falls through to `loadCustomRoleConfig` when that MISSES. So an
  //    `agents.config.role_config` row whose slug collides with a built-in is
  //    never read by dispatch — dropping it here shows the truth rather than
  //    advertising an override that does not exist. (This comment previously
  //    claimed the dispatcher "honors the tenant's per-role override
  //    transparently"; it does not, and never did.)
  //  - dedupe by slug (last write wins — operators can't reach this state via
  //    the synth UI today, but the builder will let them seed multiple rows
  //    with the same slug while iterating)
  const customsBySlug = new Map<string, EffectiveCatalogEntry>();
  for (const row of rows) {
    const slug = row.role?.trim();
    if (!slug) continue;
    if (builtinSlugs.has(slug)) continue;

    const name = row.name?.trim() || slug;
    const purpose = derivePurpose(row, name);

    customsBySlug.set(slug, {
      slug,
      displayName: name,
      category: CUSTOM_CATEGORY,
      purpose,
      kind: "custom",
    });
  }

  return [...builtins, ...customsBySlug.values()];
}

/**
 * Pull a short purpose phrase for a custom agent, preferring (in order):
 *
 *  1. The first sentence / line of `config.role_config.systemPrompt`
 *     (JD-synth writes a long prompt here; the lede usually summarizes the
 *     role's job).
 *  2. The custom display name from `config.role_config.displayName`.
 *  3. The fallback spelled in the F3 brief: `Custom agent — <name>`.
 *
 * Always truncated to 200 chars so the cmdk popover row stays single-line.
 */
function derivePurpose(row: AgentRow, name: string): string {
  const cfg = row.config ?? {};
  const roleCfg = (cfg as { role_config?: RoleConfigShape }).role_config ?? {};

  const prompt = typeof roleCfg.systemPrompt === "string" ? roleCfg.systemPrompt.trim() : "";
  if (prompt) {
    // First non-empty line — JD-synth prompts open with a role summary
    // sentence (see app/(app)/agents/new/actions.ts synth prompt rules).
    const firstLine = prompt.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (firstLine) return truncate(firstLine.trim(), 200);
  }

  const displayName = typeof roleCfg.displayName === "string" ? roleCfg.displayName.trim() : "";
  if (displayName && displayName !== name) {
    return truncate(displayName, 200);
  }

  return `Custom agent — ${name}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
