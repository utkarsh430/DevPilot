// Skill selection — runs at dispatch time.
//
// Contract: given (tenantId, role, ticketText), return the top-N installed
// skills relevant to this role + ticket. The selection is "cheap": a keyword
// pre-filter on `targets` + `triggers`, optionally followed by a Haiku pass
// over the survivors to rank by relevance.
//
// "Installed" means a row in `public.skills` whose `tenant_id` equals the
// caller's tenant — i.e. it has been cloned via the marketplace install flow.
// Public rows (tenant_id IS NULL) are intentionally NOT considered here:
// operators must explicitly install a skill into their tenant for it to take
// effect at runtime. That matches the locked Phase 1 governance decision
// (read-only verified bundles, install is the consent step).
//
// The selector is deliberately tolerant of misconfiguration. If the Haiku
// pass fails (network blip, no API key in this environment) we fall back to
// the keyword pre-filter result so dispatch still produces a sensible prompt.

import { z } from "zod";
import { supabaseService } from "@/lib/db/server";
import { generateObjectForTenant } from "@/lib/llm/generate.server";
import type { SkillRow } from "@/lib/skills/types";

export const DEFAULT_TOP_N = 3;
const MAX_CANDIDATES_FOR_RANK = 8;

export type SelectSkillsArgs = {
  tenantId: string;
  role: string;
  ticketText: string;
  topN?: number;
  /** When false, skip the LLM rank step and return keyword-filtered survivors. */
  enableRank?: boolean;
};

export type SelectedSkill = {
  id: string;
  name: string;
  version: string;
  body: string;
  score: number;
  reason?: string;
};

export async function selectSkillsForDispatch(args: SelectSkillsArgs): Promise<SelectedSkill[]> {
  const topN = Math.max(1, Math.min(args.topN ?? DEFAULT_TOP_N, 8));
  const installed = await loadInstalledSkills(args.tenantId);
  if (installed.length === 0) return [];

  const filtered = keywordFilter(installed, args.role, args.ticketText);
  if (filtered.length === 0) return [];

  // Trivial path: fewer survivors than topN — skip the rank call.
  if (filtered.length <= topN || args.enableRank === false) {
    return filtered.slice(0, topN).map((s, i) => ({
      id: s.id,
      name: s.name,
      version: s.version,
      body: s.body,
      score: filtered.length - i,
      reason: "keyword-prefilter",
    }));
  }

  // Cap the ranker input — Haiku is cheap but not free.
  const candidates = filtered.slice(0, MAX_CANDIDATES_FOR_RANK);
  try {
    const ranked = await rankWithHaiku(args.tenantId, candidates, args.role, args.ticketText);
    const byScore = ranked
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    const mapped: (SelectedSkill | null)[] = byScore.map((r) => {
      const src = candidates.find((c) => c.id === r.id);
      // Defensive: drop ranker hallucinations that point at unknown ids.
      if (!src) return null;
      return {
        id: src.id,
        name: src.name,
        version: src.version,
        body: src.body,
        score: r.score,
        reason: r.reason,
      };
    });
    return mapped.filter((x): x is SelectedSkill => x !== null);
  } catch {
    // Fall back to the keyword pre-filter result. Dispatch must not fail
    // because the marketplace ranker had a hiccup.
    return candidates.slice(0, topN).map((s, i) => ({
      id: s.id,
      name: s.name,
      version: s.version,
      body: s.body,
      score: candidates.length - i,
      reason: "rank-failed-fallback",
    }));
  }
}

async function loadInstalledSkills(tenantId: string): Promise<SkillRow[]> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("skills")
    .select(
      "id, tenant_id, name, version, manifest, body, targets, triggers, installed_from_skill_id, created_at",
    )
    .eq("tenant_id", tenantId);
  if (error || !data) return [];
  return data as unknown as SkillRow[];
}

function keywordFilter(skills: SkillRow[], role: string, ticketText: string): SkillRow[] {
  const text = ticketText.toLowerCase();
  const scored = skills
    .map((s) => {
      // targets gating: empty targets = applies to any role.
      const targets = Array.isArray(s.targets) ? s.targets : [];
      const targetHit = targets.length === 0 || targets.includes(role);
      if (!targetHit) return null;

      // triggers boost: any trigger keyword that appears in ticket text adds 1.
      const triggers = Array.isArray(s.triggers) ? s.triggers : [];
      let trigHits = 0;
      for (const t of triggers) {
        if (typeof t === "string" && t.length > 0 && text.includes(t.toLowerCase())) {
          trigHits++;
        }
      }
      // Roles in targets list count toward score so role-specialised skills
      // float above generic ones even when no trigger words match.
      const targetBoost = targets.includes(role) ? 1 : 0;
      const score = trigHits * 2 + targetBoost;
      return { skill: s, score };
    })
    .filter((x): x is { skill: SkillRow; score: number } => x !== null)
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.skill);
}

const RankSchema = z.object({
  ranked: z
    .array(
      z.object({
        id: z.string(),
        score: z.number().int().min(0).max(10),
        reason: z.string().max(160),
      }),
    )
    .max(MAX_CANDIDATES_FOR_RANK),
});

async function rankWithHaiku(
  tenantId: string,
  candidates: SkillRow[],
  role: string,
  ticketText: string,
): Promise<{ id: string; score: number; reason: string }[]> {
  const truncated = ticketText.length > 1200 ? ticketText.slice(0, 1200) + "…" : ticketText;
  const summary = candidates
    .map(
      (s) =>
        `- id=${s.id} name="${s.name}" targets=${JSON.stringify(s.targets)} summary="${s.manifest?.summary ?? ""}"`,
    )
    .join("\n");

  // Auth-mode-aware: the local runner in claude_code mode, the tenant-resolved
  // API key in api_key mode. Throwing on failure keeps the caller's existing
  // keyword-prefilter fallback as the safety net.
  const res = await generateObjectForTenant({
    tenantId,
    featureName: "Skill ranking",
    tier: "cheap",
    schema: RankSchema,
    schemaHint:
      '{"ranked":[{"id":"<candidate id verbatim>","score":<integer 0-10>,"reason":"<one short sentence, max 160 chars>"}]}',
    system:
      "You score how relevant each candidate skill is to a ticket being worked by the named role. " +
      "Score 0 = irrelevant. 10 = perfect match. Most candidates should score 0-4; reserve 7+ for clear matches. " +
      "Return one entry per candidate id you were given; do not invent ids.",
    prompt:
      `Role: ${role}\n\nTicket:\n${truncated}\n\nCandidate skills:\n${summary}\n\n` +
      `Return scores for each candidate id.`,
    // 60s ceiling (same as dep-suggest / data-source suggestions): falling
    // back fast to the keyword prefilter beats minutes of dispatch latency
    // waiting out the one-shot bridge's 120s default behind a busy runner.
    timeoutMs: 60_000,
  });
  if (!res.ok) throw new Error(res.error);
  return res.object.ranked.map((r) => ({ id: r.id, score: r.score, reason: r.reason }));
}
