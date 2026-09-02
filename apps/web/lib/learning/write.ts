// DB write logic for the learning review queue + preferences page.
//
// ── Why a plain module (no `server-only`, no session) ──
// Every function here takes an injected `SupabaseClient` and an already-resolved
// `tenantId`, so the whole write path is unit-testable with a fake client — the
// same DI split `harvest-batch.ts` / `harvest.server.ts` and `extract-batch.ts` /
// `extract.server.ts` use. The `"use server"` wrapper (`lib/learning/actions.ts`)
// derives `tenantId` from the session and passes `supabaseService()`; it never
// re-implements the SQL. This module MUST NOT be a `"use server"` file: none of
// these are browser-callable endpoints (they take a raw tenantId), which is the
// exact reason `createTicketCore` lives in `lib/`, not `board/actions.ts`.
//
// ── Security (load-bearing) ──
// `agent_learnings` denies ALL JWT-role writes by design (migration
// 20260735000000) — a browser-writable status would let a compromised client
// self-promote an adversarial lesson to `active`, which PR 4 then feeds into
// every run unreviewed. So writes run on the SERVICE client (RLS off), and the
// `.eq("tenant_id", tenantId)` on EVERY update/insert is the ENTIRE tenant
// isolation boundary. A status flip / edit / archive for a row whose tenant_id
// differs from the caller's matches zero rows → returns `not found`, never a
// cross-tenant write. This is the recurring service-role-scoping class AGENTS.md
// documents; the co-located `.eq("tenant_id", …)` is the rule.
//
// Lesson bodies are UNTRUSTED (principle 6). Operator-authored Create/Edit bodies
// are `redactEvidence`-scrubbed + length-bounded here (a pasted secret in a
// hand-typed preference is a live risk), and categories are grounded through the
// closed vocabulary regardless of caller input.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEDUPE_PEER_CAP,
  groundLessonCategory,
  isDuplicateBody,
  LESSON_BODY_MAX_CHARS,
  type LessonCategory,
} from "@/lib/learning/extract";
import { redactEvidence } from "@/lib/learning/redact";

const TABLE = "agent_learnings";

/** The lifecycle transitions the review queue / preferences page can drive. */
export type LearningTargetStatus = "active" | "rejected" | "archived";

export type WriteOk = { ok: true; id: string };
export type WriteErr = { ok: false; error: string };
export type WriteResult = WriteOk | WriteErr;

/** Create result: a near-duplicate is surfaced (not inserted) with the existing
 *  body so the UI can point at it, rather than silently double-inserting. */
export type CreateResult = WriteOk | (WriteErr & { duplicate?: boolean; existingBody?: string });

/** Sanitise an operator-typed body: redact secrets/paths, bound the length,
 *  trim. Empty after that is a hard error (the DB CHECK requires non-empty). */
export function sanitizeLessonBody(raw: string): string {
  return redactEvidence(raw).trim().slice(0, LESSON_BODY_MAX_CHARS).trim();
}

/**
 * Flip a learning's status (approve → active / reject → rejected / archive →
 * archived), id + tenant scoped. `approvedBy` is stamped only on the approve
 * path. Returns `not found` (never a cross-tenant write) when no row matches the
 * (id, tenant) pair.
 */
export async function transitionLearningStatus(
  db: SupabaseClient,
  args: { id: string; tenantId: string; status: LearningTargetStatus; approvedBy?: string | null },
): Promise<WriteResult> {
  const patch: Record<string, unknown> = { status: args.status };
  if (args.status === "active") patch.approved_by = args.approvedBy ?? null;
  const { data, error } = await db
    .from(TABLE)
    .update(patch)
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "not found" };
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Edit a learning's `body` (and optionally `category`) only — provenance columns
 * (`status`, `created_by`, `approved_by`, `source_mistake_id`) are deliberately
 * left untouched so an edit does not launder a candidate into active or erase
 * where it came from. Id + tenant scoped.
 */
export async function editLearningBody(
  db: SupabaseClient,
  args: { id: string; tenantId: string; body: string; category?: string },
): Promise<WriteResult> {
  const body = sanitizeLessonBody(args.body);
  if (body.length === 0) return { ok: false, error: "lesson body is empty" };
  const patch: Record<string, unknown> = { body };
  if (args.category !== undefined) patch.category = groundLessonCategory(args.category);
  const { data, error } = await db
    .from(TABLE)
    .update(patch)
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "not found" };
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Create a hand-authored user-scope preference. Forces the CHECK-satisfying shape
 * a manual lesson must have (scope='user', role_slug=null, source_mistake_id=null,
 * status='active'), grounds the category, sanitises the body, and runs the SAME
 * Jaccard dedupe the extractor uses against existing active + candidate user
 * lessons — surfacing a near-duplicate rather than double-inserting.
 */
export async function createUserLesson(
  db: SupabaseClient,
  args: { tenantId: string; body: string; category?: string; createdBy: string },
): Promise<CreateResult> {
  const body = sanitizeLessonBody(args.body);
  if (body.length === 0) return { ok: false, error: "lesson body is empty" };
  const category: LessonCategory = groundLessonCategory(args.category, "preference");

  // Dedupe against this tenant's existing active + candidate user lessons.
  const { data: peers, error: peersErr } = await db
    .from(TABLE)
    .select("body")
    .eq("tenant_id", args.tenantId)
    .eq("scope", "user")
    .is("role_slug", null)
    .in("status", ["active", "candidate"]);
  if (peersErr) return { ok: false, error: peersErr.message };
  const existingBodies = (peers ?? [])
    .map((p) => (p as { body: string }).body)
    .slice(0, DEDUPE_PEER_CAP);
  const dup = existingBodies.find((b) => isDuplicateBody(body, [b]));
  if (dup) {
    return {
      ok: false,
      duplicate: true,
      existingBody: dup,
      error: "A very similar preference already exists.",
    };
  }

  const { data, error } = await db
    .from(TABLE)
    .insert({
      tenant_id: args.tenantId,
      scope: "user",
      role_slug: null,
      category,
      body,
      status: "active",
      source_mistake_id: null,
      created_by: args.createdBy,
      approved_by: null,
    })
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "insert returned no row" };
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Read-merge-write a single key into `tenants.config` jsonb WITHOUT clobbering
 * sibling keys (`llm_auth_mode`, `default_agent_id`, …). Non-atomic (two round
 * trips) — the accepted risk mirrored from `setLlmAuthModeAction`.
 */
export async function setTenantConfigKey(
  db: SupabaseClient,
  args: { tenantId: string; key: string; value: unknown },
): Promise<{ ok: true } | WriteErr> {
  const { data: tenant, error: readErr } = await db
    .from("tenants")
    .select("config")
    .eq("id", args.tenantId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!tenant) return { ok: false, error: "tenant not found" };
  const config = { ...((tenant.config ?? {}) as Record<string, unknown>) };
  config[args.key] = args.value;
  const { error: writeErr } = await db.from("tenants").update({ config }).eq("id", args.tenantId);
  if (writeErr) return { ok: false, error: writeErr.message };
  return { ok: true };
}
