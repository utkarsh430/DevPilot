// Phase 1 / M10 — per-agent data-source scoping.
//
// Each agent declares the data sources it may query via
// `agents.config.data_source_ids: string[]`. Before any queryDb / queryDbSmart
// call, the engine route MUST verify the requested data_source_id appears in
// the calling agent's allowed list. This is the operator's lever to keep,
// say, the Engineer role away from a finance database the Data Engineer is
// allowed to read.

import { supabaseService } from "@/lib/db/server";

/**
 * Returns the agent's allowed `data_source_ids` from `agents.config`. Empty
 * array if the column is absent / null / not an array — callers should treat
 * an empty list as "no data sources permitted" and refuse the tool call.
 */
export async function currentAgentDataSources(agentId: string): Promise<string[]> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("agents")
    .select("config")
    .eq("id", agentId)
    .maybeSingle();
  if (error || !data) return [];
  const cfg = (data.config ?? {}) as Record<string, unknown>;
  const ids = cfg.data_source_ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Add a data source id to an agent's allowed list. Idempotent — duplicate adds
 * are no-ops. Used by the M10 acceptance script and by the operator-facing
 * agent config UI (future).
 */
export async function addAgentDataSource(agentId: string, dataSourceId: string): Promise<void> {
  const supabase = supabaseService();
  const { data: row, error } = await supabase
    .from("agents")
    .select("config")
    .eq("id", agentId)
    .maybeSingle();
  if (error || !row) {
    throw new Error(`agent ${agentId} not found`);
  }
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(cfg.data_source_ids)
    ? (cfg.data_source_ids as string[]).filter((v): v is string => typeof v === "string")
    : [];
  if (existing.includes(dataSourceId)) return;
  const next = { ...cfg, data_source_ids: [...existing, dataSourceId] };
  const { error: upErr } = await supabase.from("agents").update({ config: next }).eq("id", agentId);
  if (upErr) throw new Error(`agent update failed: ${upErr.message}`);
}
