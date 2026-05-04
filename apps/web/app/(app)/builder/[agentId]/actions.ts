"use server";

// Phase 1 / M16 — Agent Builder server actions.
// Phase 2.5 / M6 — adds the cohort-plan-aware save, the data-source Suggest
// action, and the tenant-member listing for the Runners gate.
//
//  loadAgentCanvasAction    — fetch the agents row + decompile its config into
//                             a canvas. New agents (no row yet) seed an empty
//                             canvas; existing agents either replay the
//                             embedded canvas (round-trip) or synthesise one
//                             from the legacy fields. Phase 2.5: passes the
//                             agents `name` column through to decompile so the
//                             JD-synth empty-canvas case shows a populated
//                             starter card.
//  saveAgentCanvasAction    — compile the canvas to a config payload, upsert
//                             into agents. Phase 2.5 surfaces the runners
//                             allow-list and threads it through to compile.
//  fileTestTicketAction     — file an ad-hoc ticket against the agent (or a
//                             tenant-scoped temp agent created for the
//                             builder session). Bypasses the Runners gate —
//                             the test ticket targets an ephemeral role, not
//                             the saved workflow.
//  installedLeavesAction    — list installed skills / data sources / tool
//                             packages so the palette UI can populate
//                             pickers. Cheap, RLS-scoped.
//  suggestDataSourcesAction — Phase 2.5 / M6 — Haiku-rerank installed data
//                             sources by relevance to a given role + sample
//                             ticket text. Returns up to N suggestions with
//                             rationale; the UI renders these as a checkbox
//                             list and the operator picks which to attach.
//  listTenantMembersAction  — Phase 2.5 / M6 — list tenant members (user id +
//                             email) so the Runners picker can render the
//                             allow-list combobox.

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { compileCanvas } from "@/lib/builder/compile";
import { decompileConfig } from "@/lib/builder/decompile";
import { generateObjectForTenant } from "@/lib/llm/generate.server";
import type { BuilderCanvas, BuilderCompiledConfig } from "@/lib/builder/types";

const NEW_AGENT_SENTINEL = "new";

export type LoadCanvasResult =
  | {
      ok: true;
      agentId: string | null;
      tenantId: string;
      canvas: BuilderCanvas;
      compiled: BuilderCompiledConfig | null;
      synthesised: boolean;
      isNew: boolean;
      /** Phase 2.5 / M6 — agents.name; the client surfaces it for the title. */
      agentName: string | null;
      /** Phase 2.5 / M6 — current allowed runners (or "all"). */
      allowedRunnerUserIds: string[] | "all";
    }
  | { ok: false; error: string };

export async function loadAgentCanvasAction(agentId: string): Promise<LoadCanvasResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  if (agentId === NEW_AGENT_SENTINEL) {
    return {
      ok: true,
      agentId: null,
      tenantId,
      canvas: emptyCanvas(),
      compiled: null,
      synthesised: false,
      isNew: true,
      agentName: null,
      allowedRunnerUserIds: "all",
    };
  }

  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, role, config")
    .eq("tenant_id", tenantId)
    .eq("id", agentId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: `agent ${agentId} not found` };

  const config = (data.config ?? {}) as BuilderCompiledConfig;
  // Phase 2.5 / M6 — pass the agents.name column through so the JD-synth
  // empty-canvas case (no role_config, but row has name+role) seeds a
  // populated entry node instead of a blank canvas.
  const decompiled = decompileConfig(config, {
    fallbackRoleSlug: data.role as string,
    fallbackDisplayName: (data.name as string) ?? undefined,
  });
  if (!decompiled.ok) {
    return { ok: false, error: decompiled.error };
  }

  const allowed = normaliseAllowedRunners(config.allowed_runner_user_ids);

  return {
    ok: true,
    agentId: data.id as string,
    tenantId,
    canvas: decompiled.canvas,
    compiled: config,
    synthesised: decompiled.synthesised,
    isNew: false,
    agentName: (data.name as string) ?? null,
    allowedRunnerUserIds: allowed,
  };
}

function normaliseAllowedRunners(
  raw: BuilderCompiledConfig["allowed_runner_user_ids"],
): string[] | "all" {
  if (raw === undefined || raw === null) return "all";
  if (raw === "all") return "all";
  if (Array.isArray(raw)) {
    const cleaned = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (cleaned.length === 0) return "all";
    return Array.from(new Set(cleaned)).sort();
  }
  return "all";
}

export type SaveCanvasInput = {
  agentId: string;
  canvas: BuilderCanvas;
  customRolePrompts?: Record<string, { systemPrompt: string; onSuccessStatus: string }>;
  /**
   * Phase 2.5 / M6 — runners allow-list. `"all"` (or omitted) means open to
   * every tenant member. Otherwise: explicit user ids.
   */
  allowedRunnerUserIds?: string[] | "all";
};

export type SaveCanvasResult =
  | { ok: true; agentId: string; entryRoleSlug: string }
  | { ok: false; error: string };

export async function saveAgentCanvasAction(input: SaveCanvasInput): Promise<SaveCanvasResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const supabase = supabaseService();

  if (input.agentId === NEW_AGENT_SENTINEL) {
    const compiled = compileCanvas({
      canvas: input.canvas,
      customRolePrompts: input.customRolePrompts,
      allowedRunnerUserIds: input.allowedRunnerUserIds,
    });
    if (!compiled.ok) return { ok: false, error: compiled.error };
    const name = compiled.config.role_config?.displayName ?? compiled.entryRoleSlug;
    // Insert a new agents row. Use the entry role slug as the role text.
    const newId = randomUUID();
    const { error } = await supabase.from("agents").insert({
      id: newId,
      tenant_id: tenantId,
      name,
      role: compiled.entryRoleSlug,
      config: compiled.config,
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/builder/${newId}`);
    return { ok: true, agentId: newId, entryRoleSlug: compiled.entryRoleSlug };
  }

  // Update path. Refuse if the row belongs to a different tenant (RLS would
  // also reject, but the service-role client doesn't enforce — we check
  // explicitly).
  //
  // The read also fetches `config`, because this UPDATE writes `config` as a
  // WHOLE-OBJECT overwrite. The canvas cannot represent a systemPrompt, so
  // without feeding the stored role_config back into the compiler, saving a
  // JD-synthesized agent silently destroys the prompt that makes it
  // dispatchable. Compile AFTER the read, never before.
  const { data: row, error: readErr } = await supabase
    .from("agents")
    .select("id, config")
    .eq("tenant_id", tenantId)
    .eq("id", input.agentId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: `agent ${input.agentId} not found in tenant` };

  const storedConfig = (row.config ?? {}) as BuilderCompiledConfig;
  const compiled = compileCanvas({
    canvas: input.canvas,
    customRolePrompts: input.customRolePrompts,
    allowedRunnerUserIds: input.allowedRunnerUserIds,
    existingRoleConfig: storedConfig.role_config,
  });
  if (!compiled.ok) return { ok: false, error: compiled.error };
  const name = compiled.config.role_config?.displayName ?? compiled.entryRoleSlug;

  const { error } = await supabase
    .from("agents")
    .update({
      name,
      role: compiled.entryRoleSlug,
      config: compiled.config,
    })
    .eq("id", input.agentId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/builder/${input.agentId}`);
  return {
    ok: true,
    agentId: input.agentId,
    entryRoleSlug: compiled.entryRoleSlug,
  };
}

// ---------------------------------------------------------------------------
// Test-run sidebar — file an ad-hoc ticket against the builder's canvas.

export type FileTestTicketInput = {
  agentId: string;
  canvas: BuilderCanvas;
  ticketTitle: string;
  ticketDescription: string;
  /** Sets `tickets.acceptance_strategy`. Defaults to the canvas fan_out hint. */
  acceptanceStrategyOverride?: string;
  customRolePrompts?: Record<string, { systemPrompt: string; onSuccessStatus: string }>;
};

export type FileTestTicketResult =
  | { ok: true; ticketId: string; ephemeralAgentId: string }
  | { ok: false; error: string };

/**
 * The Test-Run sidebar files a real ticket but scoped to an ephemeral agents
 * row so it never pollutes the saved agent. Pattern:
 *   1. compile the canvas into config (must succeed)
 *   2. insert an ephemeral agents row tagged config.source="builder-test"
 *   3. insert a ticket with `requested_role = <entry slug>` and the canvas's
 *      acceptance_strategy
 *   4. emit ticket/dispatch-needed to kick off the dispatcher
 * The caller is responsible for tearing down the ephemeral agent + ticket
 * (the acceptance script and the UI both clean up on terminal status).
 *
 * Phase 2.5 / M6: this path INTENTIONALLY bypasses the Runners gate enforced
 * by `createTicketAction`. The test ticket targets an ephemeral role unique
 * to this builder session, not the saved workflow, so the gate doesn't apply.
 */
export async function fileTestTicketAction(
  input: FileTestTicketInput,
): Promise<FileTestTicketResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const compiled = compileCanvas({
    canvas: input.canvas,
    customRolePrompts: input.customRolePrompts,
  });
  if (!compiled.ok) return { ok: false, error: compiled.error };

  const supabase = supabaseService();

  // 1. Ephemeral agents row.
  const ephemeralRole = `${compiled.entryRoleSlug}__test_${randomUUID().slice(0, 8)}`;
  const ephemeralAgentId = randomUUID();
  const ephemeralConfig: BuilderCompiledConfig = {
    ...compiled.config,
    source: "builder",
  };
  const { error: agentErr } = await supabase.from("agents").insert({
    id: ephemeralAgentId,
    tenant_id: tenantId,
    name: `${compiled.config.role_config?.displayName ?? compiled.entryRoleSlug} (builder test)`,
    role: ephemeralRole,
    config: { ...ephemeralConfig, source: "builder-test", builder_agent_id: input.agentId },
  });
  if (agentErr) return { ok: false, error: agentErr.message };

  // 2. Ticket.
  const acceptanceStrategy =
    input.acceptanceStrategyOverride ?? compiled.config.fan_out?.acceptance_strategy ?? "single";
  const ticketId = randomUUID();
  const { error: tErr } = await supabase.from("tickets").insert({
    id: ticketId,
    tenant_id: tenantId,
    title: input.ticketTitle,
    description: input.ticketDescription,
    status: "ready",
    priority: 3,
    acceptance_strategy: acceptanceStrategy,
    requested_role: ephemeralRole,
  });
  if (tErr) {
    // Compensate the ephemeral agent.
    await supabase.from("agents").delete().eq("id", ephemeralAgentId);
    return { ok: false, error: tErr.message };
  }

  // 3. Kick the dispatcher.
  await sendEventBounded({
    name: "ticket/dispatch-needed",
    data: { ticketId, tenantId },
  });

  return { ok: true, ticketId, ephemeralAgentId };
}

// ---------------------------------------------------------------------------
// Palette helpers.

export type InstalledLeaves = {
  skills: { id: string; name: string; version: string }[];
  toolPackages: { id: string; name: string; version: string }[];
  dataSources: { id: string; name: string; kind: string }[];
};

export async function installedLeavesAction(): Promise<InstalledLeaves> {
  await requireUser();
  const tenantId = await requireTenantId();
  const supabase = supabaseService();

  const [skillsRes, toolsRes, dsRes] = await Promise.all([
    supabase
      .from("skills")
      .select("id, name, version")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true }),
    supabase
      .from("tool_packages")
      .select("id, name, version")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true }),
    supabase
      .from("data_sources")
      .select("id, name, kind")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true }),
  ]);

  return {
    skills: (skillsRes.data ?? []) as { id: string; name: string; version: string }[],
    toolPackages: (toolsRes.data ?? []) as { id: string; name: string; version: string }[],
    dataSources: (dsRes.data ?? []) as { id: string; name: string; kind: string }[],
  };
}

// ---------------------------------------------------------------------------
// Phase 2.5 / M6 — Suggest data sources (Haiku rerank).
//
// Mirrors the pattern in `lib/skills/select.ts:rankWithHaiku`: pull every
// installed data source in the tenant, optionally narrow by ticket sample
// text + role, and ask Haiku to score each candidate 0-10 with a one-line
// rationale. The action surfaces ALREADY-attached ids so the UI can dedupe
// without a round trip.
//
// Tolerant of misconfiguration: if Haiku is unreachable or returns garbage,
// we fall back to the top-N data sources by name (no rationale) so the UI
// still has something to render.

export type SuggestDataSourcesInput = {
  agentId: string;
  roleSlug: string;
  /**
   * Optional sample text — when present we hand it to Haiku as the ticket
   * context. The client typically supplies the concatenated title +
   * description of recent ready/done tickets matching `requested_role`.
   */
  ticketSampleText?: string;
};

export type SuggestedDataSource = {
  id: string;
  name: string;
  kind: string;
  score: number;
  reason: string;
  /** True when the data source is already attached to the agent. */
  alreadyAttached: boolean;
};

export type SuggestDataSourcesResult =
  | { ok: true; suggestions: SuggestedDataSource[]; rankerUsed: boolean }
  | { ok: false; error: string };

const SuggestInputSchema = z.object({
  agentId: z.string().min(1),
  roleSlug: z.string().min(1).max(64),
  ticketSampleText: z.string().max(8_000).optional(),
});

const MAX_SUGGEST_CANDIDATES = 12;
const TOP_N_SUGGESTIONS = 6;

const SuggestRankSchema = z.object({
  ranked: z
    .array(
      z.object({
        id: z.string(),
        score: z.number().int().min(0).max(10),
        reason: z.string().max(160),
      }),
    )
    .max(MAX_SUGGEST_CANDIDATES),
});

export async function suggestDataSourcesAction(
  input: SuggestDataSourcesInput,
): Promise<SuggestDataSourcesResult> {
  const parsed = SuggestInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "invalid input",
    };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const supabase = supabaseService();

  // 1. All installed data sources in the tenant.
  const { data: dsRows, error: dsErr } = await supabase
    .from("data_sources")
    .select("id, name, kind")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true });
  if (dsErr) return { ok: false, error: dsErr.message };
  const candidates = (dsRows ?? []) as { id: string; name: string; kind: string }[];
  if (candidates.length === 0) {
    return { ok: true, suggestions: [], rankerUsed: false };
  }

  // 2. Already-attached set on the target agent (if it exists). Tolerate
  //    not-yet-saved agents (sentinel "new") — no attachments to dedupe.
  let attached = new Set<string>();
  if (parsed.data.agentId !== NEW_AGENT_SENTINEL) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("config")
      .eq("tenant_id", tenantId)
      .eq("id", parsed.data.agentId)
      .maybeSingle();
    const cfg = (agentRow?.config ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(cfg.data_source_ids) ? (cfg.data_source_ids as unknown[]) : [];
    attached = new Set(ids.filter((v): v is string => typeof v === "string"));
  }

  // 3. Cap candidates for the ranker. Cheap on Haiku, but bounded.
  const candidatesForRank = candidates.slice(0, MAX_SUGGEST_CANDIDATES);

  const sampleText = parsed.data.ticketSampleText?.trim() ?? "";
  // If there's no sample text, skip the Haiku call and return the top-N by
  // alphabetical order (with score 0). The UI still gets something to show.
  if (sampleText.length === 0) {
    const suggestions = candidatesForRank.slice(0, TOP_N_SUGGESTIONS).map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      score: 0,
      reason:
        "No ticket sample available — listing by name. Provide recent tickets matching this role to rank.",
      alreadyAttached: attached.has(c.id),
    }));
    return { ok: true, suggestions, rankerUsed: false };
  }

  // 4. Ask the cheap tier to score each candidate 0-10 with a one-line
  //    rationale — auth-mode-aware: over the local runner in claude_code
  //    mode, over the tenant-resolved API key in api_key mode.
  try {
    const truncated = sampleText.length > 1200 ? sampleText.slice(0, 1200) + "…" : sampleText;
    const summary = candidatesForRank
      .map((c) => `- id=${c.id} name="${c.name}" kind=${c.kind}`)
      .join("\n");
    const res = await generateObjectForTenant({
      tenantId,
      featureName: "Data-source suggestions",
      tier: "cheap",
      schema: SuggestRankSchema,
      schemaHint:
        '{"ranked":[{"id":"<candidate id verbatim>","score":<integer 0-10>,"reason":"<one short sentence, max 160 chars>"}]}',
      system:
        "You score how relevant each candidate data source is to the named role and the recent ticket sample. " +
        "Score 0 = irrelevant. 10 = perfect match. Most candidates should score 0-4; reserve 7+ for clear matches. " +
        "Reasons must be one short sentence. Return one entry per candidate id you were given; do not invent ids.",
      prompt:
        `Role: ${parsed.data.roleSlug}\n\nRecent tickets the role is working:\n${truncated}\n\n` +
        `Candidate data sources:\n${summary}\n\n` +
        `Return scores for each candidate id.`,
      // Interactive modal — keep the worst case bounded well under the
      // bridge's 2-min default so a downed runner mid-poll doesn't hang the UI.
      timeoutMs: 60_000,
    });
    if (!res.ok) throw new Error(res.error);
    const scoreById = new Map<string, { score: number; reason: string }>();
    for (const r of res.object.ranked) {
      scoreById.set(r.id, { score: r.score, reason: r.reason });
    }
    const ranked = candidatesForRank
      .map((c) => ({
        ...c,
        score: scoreById.get(c.id)?.score ?? 0,
        reason: scoreById.get(c.id)?.reason ?? "no signal",
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N_SUGGESTIONS);

    const suggestions: SuggestedDataSource[] = ranked.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      score: c.score,
      reason: c.reason,
      alreadyAttached: attached.has(c.id),
    }));
    return { ok: true, suggestions, rankerUsed: true };
  } catch (e) {
    // Fall back to the alphabetical top-N. We surface the error message in
    // a debug-friendly way but still return ok=true so the UI shows results.
    const suggestions: SuggestedDataSource[] = candidatesForRank
      .slice(0, TOP_N_SUGGESTIONS)
      .map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        score: 0,
        reason: `Ranker unavailable (${e instanceof Error ? e.message : "unknown"}). Showing top installed sources by name.`,
        alreadyAttached: attached.has(c.id),
      }));
    return { ok: true, suggestions, rankerUsed: false };
  }
}

// ---------------------------------------------------------------------------
// Phase 2.5 / M6 — list tenant members for the Runners picker.
//
// Joins `tenant_members` with `auth.users` so the picker can show a real
// display name + email. RLS would normally pin `tenant_members` to the
// caller's row; we use the service-role client to read every member of the
// caller's tenant, then filter to that tenant id in the SQL.
//
// The action returns the CALLER's own row too — the UI can use that to
// pre-select "just me" if the operator wants to lock the workflow down.

export type TenantMemberRow = {
  userId: string;
  email: string | null;
  role: string;
  isSelf: boolean;
};

export type ListTenantMembersResult =
  | { ok: true; members: TenantMemberRow[] }
  | { ok: false; error: string };

export async function listTenantMembersAction(): Promise<ListTenantMembersResult> {
  const user = await requireUser();
  const tenantId = await requireTenantId();
  const supabase = supabaseService();

  const { data: members, error } = await supabase
    .from("tenant_members")
    .select("user_id, role")
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: error.message };
  const rows = (members ?? []) as { user_id: string; role: string }[];
  if (rows.length === 0) {
    return { ok: true, members: [] };
  }

  // Look up emails via the Auth admin API. supabaseService() uses the
  // service-role key which can read auth.users.
  const emailById = new Map<string, string | null>();
  await Promise.all(
    rows.map(async (r) => {
      try {
        const res = await supabase.auth.admin.getUserById(r.user_id);
        emailById.set(r.user_id, res.data.user?.email ?? null);
      } catch {
        emailById.set(r.user_id, null);
      }
    }),
  );

  const out: TenantMemberRow[] = rows
    .map((r) => ({
      userId: r.user_id,
      email: emailById.get(r.user_id) ?? null,
      role: r.role,
      isSelf: r.user_id === user.id,
    }))
    .sort((a, b) => {
      // Self first, then alphabetical by email.
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      const ae = (a.email ?? a.userId).toLowerCase();
      const be = (b.email ?? b.userId).toLowerCase();
      return ae.localeCompare(be);
    });
  return { ok: true, members: out };
}

// ---------------------------------------------------------------------------
// Small canvas builders — used by `loadAgentCanvasAction` for the empty
// /builder/new state.

function emptyCanvas(): BuilderCanvas {
  const entryId = "n_entry";
  return {
    version: 1,
    entryNodeId: entryId,
    nodes: [
      {
        id: entryId,
        type: "role",
        position: { x: 240, y: 240 },
        data: {
          kind: "role",
          roleSlug: "pm",
          displayName: "Product Manager",
          modelTier: "default",
          runnerPolicy: "local-cc",
        },
      },
    ],
    edges: [],
  };
}
