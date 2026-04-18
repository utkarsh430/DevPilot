// Role loader — resolves a role slug (which may be built-in or custom) into
// a `RoleConfig`. Custom roles created via M5's JD-to-role synthesizer live
// in `agents.config.role_config`; built-in roles live in the in-memory ROLES
// map. The dispatcher hits this every dispatch, so the built-in branch is
// the fast path (no DB).
//
// Contract
// ────────
// • `getBuiltinRoleConfig(slug)` — sync. Returns the built-in ROLES entry
//   when the slug matches a hardcoded role, else null. Use this BEFORE
//   hitting the DB.
// • `loadCustomRoleConfig(tenantId, slug)` — async. Looks up the agents row
//   for (tenant, slug) and decodes `config.role_config` into a RoleConfig.
//   Returns null when no matching agent row exists OR the row lacks a
//   `role_config` payload (operator misconfiguration).
// • `loadRoleConfig(tenantId, slug)` — async. Built-in fast path → custom
//   slow path. Returns null only when both paths miss.
//
// Shape of `agents.config.role_config` for custom roles:
//   {
//     "displayName": "Localization Reviewer",
//     "systemPrompt": "You are a senior localization reviewer …",
//     "modelTier": "default" | "heavy" | "cheap",
//     "runnerPolicy": "api" | "local-cc",
//     "onSuccessStatus": "in_review" | "done" | …
//   }

import { supabaseService } from "@/lib/db/server";
import { ROLES, type Role, type RoleConfig } from "@/lib/roles/index";
import type { ModelTier } from "@/lib/llm/models";
import type { TicketStatus } from "@/lib/board/state";
import type { RunnerKind } from "@/lib/runners/types";
import { selectSkillsForDispatch, type SelectedSkill } from "@/lib/skills/select";
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";
import { loadOverlayForDispatch } from "@/lib/roles/overlay.server";

const BUILTIN_SLUGS: ReadonlySet<string> = new Set(Object.keys(ROLES));

const MODEL_TIERS: ReadonlySet<ModelTier> = new Set(["default", "heavy", "cheap"]);
const RUNNER_KINDS: ReadonlySet<RunnerKind> = new Set(["api", "local-cc"]);
const TICKET_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "backlog",
  "ready",
  "assigned",
  "in_progress",
  "input_required",
  "blocked",
  "in_review",
  "done",
  "failed",
]);

export function isBuiltinRole(slug: string): slug is Role {
  return BUILTIN_SLUGS.has(slug);
}

export function getBuiltinRoleConfig(slug: string): RoleConfig | null {
  if (!isBuiltinRole(slug)) return null;
  return ROLES[slug];
}

export async function loadCustomRoleConfig(
  tenantId: string,
  slug: string,
): Promise<RoleConfig | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("agents")
    .select("config, name")
    .eq("tenant_id", tenantId)
    .eq("role", slug)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;

  const cfg = (data.config ?? {}) as Record<string, unknown>;
  const rc = cfg.role_config as Record<string, unknown> | undefined;
  if (!rc) return null;

  const displayName =
    typeof rc.displayName === "string" && rc.displayName.length > 0
      ? rc.displayName
      : (data.name as string);
  const systemPrompt =
    typeof rc.systemPrompt === "string" && rc.systemPrompt.length > 0 ? rc.systemPrompt : null;
  if (!systemPrompt) return null;

  const modelTier = MODEL_TIERS.has(rc.modelTier as ModelTier)
    ? (rc.modelTier as ModelTier)
    : ("default" as ModelTier);
  const runnerPolicy = RUNNER_KINDS.has(rc.runnerPolicy as RunnerKind)
    ? (rc.runnerPolicy as RunnerKind)
    : ("local-cc" as RunnerKind);
  const onSuccessStatus = TICKET_STATUSES.has(rc.onSuccessStatus as TicketStatus)
    ? (rc.onSuccessStatus as TicketStatus)
    : ("in_review" as TicketStatus);

  return {
    role: slug as Role, // free-form at runtime; cast for the shared type
    displayName,
    systemPrompt,
    modelTier,
    runnerPolicy,
    onSuccessStatus,
  };
}

export async function loadRoleConfig(tenantId: string, slug: string): Promise<RoleConfig | null> {
  const builtin = getBuiltinRoleConfig(slug);
  if (builtin) return builtin;
  return loadCustomRoleConfig(tenantId, slug);
}

// Phase 1 / M11 — resolve a RoleConfig AND compose its dispatch-time prompt
// layers (reviewer-awareness note, then the installed-skill fence) for this
// specific ticket, through the shared `composeRoleSystemPrompt` seam.
//
// Why a separate function: lets non-ticket-aware callers (the M5 form
// preview, smoke scripts, the inspector "show me the bare role" view) keep
// using the original loaders unchanged. Composition is opt-in via this
// entry point.
//
// Currently uncalled: the dispatcher composes against the same seam inline,
// because it selects skills in its own `step.run` (so a skill failure is
// isolated and checkpointed) and emits the composed prompt onto the
// agent/run.requested event. This stays as the opt-in entry point for future
// non-dispatch callers that want the load + compose in one call.
//
// `hasTicket` is hardcoded `true`: the caller must supply `ticketText`, so
// every run reaching this function is ticket-bound by construction.
//
// The function also returns the list of skills it merged so the caller can
// log them, attach them to a trace, or surface them in the inspector. Note
// that list may be empty while the composed prompt still differs from the
// stored one: the reviewer-awareness note does not depend on skills.
export type RoleConfigWithSkills = {
  config: RoleConfig;
  skills: SelectedSkill[];
};

export async function loadRoleConfigWithSkills(args: {
  tenantId: string;
  slug: string;
  ticketText: string;
  topN?: number;
  enableRank?: boolean;
}): Promise<RoleConfigWithSkills | null> {
  const base = await loadRoleConfig(args.tenantId, args.slug);
  if (!base) return null;
  const skills = await selectSkillsForDispatch({
    tenantId: args.tenantId,
    role: args.slug,
    ticketText: args.ticketText,
    topN: args.topN,
    enableRank: args.enableRank,
  });
  // Phase 2 — the operator's overlay for this role. Read here rather than left
  // to the caller for the same reason the composition itself is: a caller that
  // forgets it gets a prompt this function claims is dispatch-equivalent and is
  // not. The inspector deliberately does NOT use this composed string (it needs
  // base-without-skills; see `prompt-inspection.ts`), only the skills list.
  const overlay = await loadOverlayForDispatch(args.tenantId, args.slug);
  return {
    config: {
      ...base,
      systemPrompt: composeRoleSystemPrompt(base, skills, true, overlay),
      // Phase 4 — CLEARED, because the contract has already been folded into the
      // composed string above. Leaving it set would make the returned object
      // claim the contract is still pending application, and a caller that
      // composed again would be relying on `applySafetyContract`'s fence guard
      // to save it rather than on the object meaning what it says.
      safetyContract: undefined,
    },
    skills,
  };
}
