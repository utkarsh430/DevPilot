"use server";

// Server actions for the M11 marketplace.
//
//  installSkillAction   — clones a public skill row (tenant_id NULL) into the
//                         caller's tenant. Stamps `installed_from_skill_id`
//                         so we can trace clones to their public source.
//  uninstallSkillAction — deletes the tenant-scoped clone. Public rows are
//                         protected by the RLS policies in
//                         20260603090000_m11_marketplace.sql (read-only for
//                         non-service_role) so this is safe.
//  installToolPackageAction / uninstallToolPackageAction — same shape for
//                         the tool_packages table. M11 only persists the
//                         manifest; runtime wiring (MCP server URL discovery,
//                         dynamic tool registration) is OUT of scope.
//  publishSkillAction   — GATED behind DEVPILOT_MARKETPLACE_PUBLISH=1. Phase 1's
//                         locked governance forbids user submissions; this
//                         action exists only so operators (the running DevPilot
//                         project itself) can seed/maintain the public set
//                         from inside the app. It refuses for everyone else.
//
// Security posture (CLAUDE.md untrusted-content rule):
//   - Skill BODIES are treated as system-prompt content at runtime. The
//     install flow surfaces a warning so operators understand they are
//     accepting prompt text into their tenant.
//   - Public rows can only be created via this gated action, which itself
//     uses the service-role client to bypass the read-only RLS. There is no
//     end-user path to write a public row.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";

export type InstallResult = { ok: true; id: string } | { ok: false; error: string };

export type UninstallResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export async function installSkillAction(publicSkillId: string): Promise<InstallResult> {
  await requireUser();
  const tenantId = await requireTenantId();
  const supabase = supabaseService();

  const { data: src, error: srcErr } = await supabase
    .from("skills")
    .select("id, name, version, manifest, body, targets, triggers, tenant_id")
    .eq("id", publicSkillId)
    .maybeSingle();
  if (srcErr || !src) return { ok: false, error: srcErr?.message ?? "skill not found" };
  if (src.tenant_id !== null) {
    return { ok: false, error: "can only install public (tenant_id null) skills" };
  }

  // Idempotent: if a clone already exists for this tenant + name + version,
  // return its id instead of erroring on the unique constraint.
  const { data: existing } = await supabase
    .from("skills")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("name", src.name as string)
    .eq("version", src.version as string)
    .maybeSingle();
  if (existing?.id) {
    return { ok: true, id: existing.id as string };
  }

  const { data: ins, error: insErr } = await supabase
    .from("skills")
    .insert({
      tenant_id: tenantId,
      name: src.name,
      version: src.version,
      manifest: src.manifest,
      body: src.body,
      targets: src.targets,
      triggers: src.triggers,
      installed_from_skill_id: src.id,
    })
    .select("id")
    .single();
  if (insErr || !ins) return { ok: false, error: insErr?.message ?? "install failed" };

  revalidatePath("/marketplace");
  return { ok: true, id: ins.id as string };
}

export async function uninstallSkillAction(installedSkillId: string): Promise<UninstallResult> {
  await requireUser();
  const tenantId = await requireTenantId();
  const supabase = supabaseService();

  // Tenant-bound delete: an attacker who knew an id from another tenant
  // can't delete it through this action because the tenant_id filter scopes
  // the WHERE clause.
  const { data, error } = await supabase
    .from("skills")
    .delete()
    .eq("id", installedSkillId)
    .eq("tenant_id", tenantId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "skill not found in tenant" };

  revalidatePath("/marketplace");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tool packages — same shape, no runtime side-effects in Phase 1.
// ---------------------------------------------------------------------------

export async function installToolPackageAction(
  publicToolPackageId: string,
): Promise<InstallResult> {
  await requireUser();
  const tenantId = await requireTenantId();
  const supabase = supabaseService();

  const { data: src, error: srcErr } = await supabase
    .from("tool_packages")
    .select("id, name, version, manifest, body, tenant_id")
    .eq("id", publicToolPackageId)
    .maybeSingle();
  if (srcErr || !src) return { ok: false, error: srcErr?.message ?? "tool package not found" };
  if (src.tenant_id !== null) {
    return { ok: false, error: "can only install public (tenant_id null) tool packages" };
  }

  const { data: existing } = await supabase
    .from("tool_packages")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("name", src.name as string)
    .eq("version", src.version as string)
    .maybeSingle();
  if (existing?.id) return { ok: true, id: existing.id as string };

  const { data: ins, error: insErr } = await supabase
    .from("tool_packages")
    .insert({
      tenant_id: tenantId,
      name: src.name,
      version: src.version,
      manifest: src.manifest,
      body: src.body,
      installed_from_tool_package_id: src.id,
    })
    .select("id")
    .single();
  if (insErr || !ins) return { ok: false, error: insErr?.message ?? "install failed" };

  revalidatePath("/marketplace");
  return { ok: true, id: ins.id as string };
}

export async function uninstallToolPackageAction(
  installedToolPackageId: string,
): Promise<UninstallResult> {
  await requireUser();
  const tenantId = await requireTenantId();
  const supabase = supabaseService();

  const { data, error } = await supabase
    .from("tool_packages")
    .delete()
    .eq("id", installedToolPackageId)
    .eq("tenant_id", tenantId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "tool package not found in tenant" };

  revalidatePath("/marketplace");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Publish — operator-only, env-gated.
// ---------------------------------------------------------------------------

const PUBLISH_FLAG_ENV = "DEVPILOT_MARKETPLACE_PUBLISH";

function publishEnabled(): boolean {
  return process.env[PUBLISH_FLAG_ENV] === "1";
}

const PublishInputSchema = z.object({
  name: z.string().min(2).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  body: z.string().min(20).max(8_000),
  manifest: z.record(z.unknown()).default({}),
  targets: z.array(z.string()).default([]),
  triggers: z.array(z.string()).default([]),
});

export type PublishSkillInput = z.infer<typeof PublishInputSchema>;

export type PublishResult = { ok: true; id: string } | { ok: false; error: string };

export async function publishSkillAction(input: PublishSkillInput): Promise<PublishResult> {
  // Gate 1 — env flag. The Phase 1 governance lock forbids the general
  // submission flow; we ship this action only so an operator can seed the
  // public catalog from inside the running app.
  if (!publishEnabled()) {
    return {
      ok: false,
      error:
        `publishing is disabled. Set ${PUBLISH_FLAG_ENV}=1 in the env to enable ` +
        `(Phase 1 marketplace is read-only for end users; see docs/DEVPILOT_PHASE1_PLAN.md ` +
        `Locked decisions for context).`,
    };
  }

  await requireUser();
  await requireTenantId(); // operator must still be signed in; tenant id is unused

  const parsed = PublishInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }

  // service_role client bypasses the public-rows-read-only RLS — this is the
  // ONLY code path that creates a public skill row.
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("skills")
    .insert({
      tenant_id: null,
      name: parsed.data.name,
      version: parsed.data.version,
      manifest: { ...parsed.data.manifest, verified: true, author: "DevPilot first-party" },
      body: parsed.data.body,
      targets: parsed.data.targets,
      triggers: parsed.data.triggers,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "publish failed" };

  revalidatePath("/marketplace");
  return { ok: true, id: data.id as string };
}
