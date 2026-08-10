"use server";

// Server actions for operator-authored skills (`/marketplace/new`,
// `/marketplace/[id]/edit`).
//
// Lives in `lib/` rather than under `app/` for the same reason
// `lib/roles/overlay-actions.ts` and `lib/automation/actions.ts` do: the forms
// are client components mounted by more than one route, and the write path
// belongs beside its store module. It also keeps this change out of
// `app/(app)/marketplace/actions.ts`, which a sibling crew is editing.
//
// ── "use server" async-only-export rule (respected) ────────────────────────
// EVERY exported symbol here is a browser-callable endpoint, so every one is an
// async action that derives `tenantId` from the SESSION (`requireTenantId()`).
// None takes a tenant id, a `tenant_id` field, or anything else that would let
// a caller nominate whose skill they are writing. The raw-tenantId DB logic
// lives in the plain `lib/skills/authoring-store.ts` (imported, never
// re-exported).
//
// ── Gating ─────────────────────────────────────────────────────────────────
// Plain `requireUser()` + `requireTenantId()` — NOT `isInstanceOperator`, which
// checks the INSTALL's first tenant and misfires for every other workspace
// (the `lib/learning/actions.ts` note). Authoring a skill is a HUMAN action:
// there is no MCP tool, nothing in `DEVPILOT_BOARD_TOOLS`, no runner path and no
// agent-facing route that reaches any of these.
//
// ── Validation happens HERE, not in the browser ────────────────────────────
// The form runs `checkSkillDraft` for live feedback, but a forged POST never
// executes that code. So the action re-runs the same pure check server-side and
// stores only what IT normalised — the client's copy is a convenience, this one
// is the rule.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { checkSkillDraft, type SkillFieldViolation } from "@/lib/skills/authoring";
import {
  runSkillAssist,
  SKILL_ASSIST_REQUEST_MAX_CHARS,
  type SkillAssistOutcome,
} from "@/lib/skills/authoring-assist";
import { defaultSkillAssistDeps } from "@/lib/skills/authoring-assist.server";
import {
  createOwnedSkill,
  deleteOwnedSkill,
  findPublicNameClash,
  resetOwnedSkillToUpstream,
  updateOwnedSkill,
} from "@/lib/skills/authoring-store";

export type SkillActionResult =
  | { ok: true; id: string; warning?: string }
  | { ok: false; error: string; violations?: SkillFieldViolation[] };

/**
 * A request-size sanity ceiling, NOT the body cap. Set far above
 * `SKILL_BODY_MAX_CHARS` on purpose: an over-cap body has to reach
 * `checkSkillDraft` so the operator gets the real "you are 42,000 characters
 * over, trim it" message rather than a flat "invalid input". Pasting a whole
 * document into the box is exactly the case that produces the most confusing
 * error, so it is the case that most needs the good one.
 */
const REQUEST_SIZE_CEILING = 1_000_000;

const DraftInput = z.object({
  name: z.string().max(4_000),
  version: z.string().max(4_000),
  summary: z.string().max(REQUEST_SIZE_CEILING),
  body: z.string().max(REQUEST_SIZE_CEILING),
  targets: z.array(z.string().max(200)).max(200),
  triggers: z.array(z.string().max(200)).max(200),
});

export type SkillDraftInput = z.infer<typeof DraftInput>;

const IdInput = z.string().uuid();

function revalidateSkillSurfaces() {
  revalidatePath("/marketplace");
}

/**
 * Warn — never refuse — when the public catalogue already carries this name.
 * See `findPublicNameClash` for why a warning is the honest strength here.
 */
async function publicClashWarning(
  db: ReturnType<typeof supabaseService>,
  name: string,
): Promise<string | undefined> {
  const clash = await findPublicNameClash(db, { name });
  if (!clash) return undefined;
  return (
    `The marketplace also has a skill called "${clash.name}" (v${clash.version}). Yours is ` +
    `separate and only your workspace can see it — but if you later install the marketplace ` +
    `one, both would be considered for the same dispatch. Rename one of them if that happens.`
  );
}

/** Create a new skill owned by the caller's workspace. */
export async function createSkillAction(input: SkillDraftInput): Promise<SkillActionResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = DraftInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Could not read the form. Try again." };

  const checked = checkSkillDraft(parsed.data);
  if (!checked.ok) {
    return {
      ok: false,
      error: "Fix the highlighted fields before saving.",
      violations: checked.violations,
    };
  }

  const db = supabaseService();
  const result = await createOwnedSkill(db, { tenantId, draft: checked.draft });
  if (!result.ok) return { ok: false, error: result.error };

  const warning = await publicClashWarning(db, checked.draft.name);
  revalidateSkillSurfaces();
  return { ok: true, id: result.id, warning };
}

/**
 * Edit one of the caller's own skills, IN PLACE (see `updateOwnedSkill` for the
 * versioning rationale). A foreign id — or a public marketplace id, whose
 * `tenant_id` is null — matches nothing and is refused; it is never edited and
 * never silently converted into a create.
 */
export async function updateSkillAction(
  skillId: string,
  input: SkillDraftInput,
): Promise<SkillActionResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const id = IdInput.safeParse(skillId);
  if (!id.success) return { ok: false, error: "skill not found in this workspace" };

  const parsed = DraftInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Could not read the form. Try again." };

  const checked = checkSkillDraft(parsed.data);
  if (!checked.ok) {
    return {
      ok: false,
      error: "Fix the highlighted fields before saving.",
      violations: checked.violations,
    };
  }

  const db = supabaseService();
  const result = await updateOwnedSkill(db, {
    id: id.data,
    tenantId,
    draft: checked.draft,
  });
  if (!result.ok) return { ok: false, error: result.error };

  const warning = await publicClashWarning(db, checked.draft.name);
  revalidateSkillSurfaces();
  revalidatePath(`/marketplace/${id.data}/edit`);
  return { ok: true, id: result.id, warning };
}

const DraftAssistInput = z.object({
  /** What the operator typed. UNTRUSTED — see `authoring-assist.ts`. */
  request: z.string().max(REQUEST_SIZE_CEILING),
  /** The body already in the box, which may be unsaved. His own text either way. */
  currentBody: z.string().max(REQUEST_SIZE_CEILING).optional(),
});

/**
 * Draft a skill from a plain-English request.
 *
 * WRITES NOTHING, and READS nothing — by design, not omission. The operator
 * reads the draft, edits it, and presses Save, which is `createSkillAction` /
 * `updateSkillAction` above; those are the only writers in this feature and both
 * re-run `checkSkillDraft` over whatever he finally accepted. So a model draft
 * is checked on the way out of the assist AND again on the way into the
 * database, and there is no path from here to any table at all.
 *
 * Every suggested ROLE is validated against the live registry inside
 * `runSkillAssist` (an invented slug is dropped and reported, never stored), and
 * suggested roles are applied to the form only when the operator says so — they
 * are never carried into a save he did not look at.
 *
 * Nothing here takes a tenant id: it is derived from the SESSION, as every
 * export in this file must be.
 */
export async function draftSkillAction(input: {
  request: string;
  currentBody?: string;
}): Promise<SkillAssistOutcome> {
  const parsed = DraftAssistInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Keep the request under ${SKILL_ASSIST_REQUEST_MAX_CHARS.toLocaleString()} characters.`,
    };
  }

  await requireUser();
  const tenantId = await requireTenantId();

  return runSkillAssist(defaultSkillAssistDeps(tenantId), {
    request: parsed.data.request,
    currentBody: parsed.data.currentBody,
  });
}

/** Delete one of the caller's own skills. Public rows are unreachable. */
export async function deleteSkillAction(skillId: string): Promise<SkillActionResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const id = IdInput.safeParse(skillId);
  if (!id.success) return { ok: false, error: "skill not found in this workspace" };

  const result = await deleteOwnedSkill(supabaseService(), { id: id.data, tenantId });
  if (!result.ok) return { ok: false, error: result.error };

  revalidateSkillSurfaces();
  return { ok: true, id: id.data };
}

/**
 * Replace one of the caller's installed copies with the catalogue's current
 * text — the "reset to original" and "take the update" control, which are the
 * same write (see `resetOwnedSkillToUpstream`).
 *
 * DESTRUCTIVE and irreversible from here: it discards whatever the operator
 * edited. The confirmation copy naming what is lost is
 * `describeCatalogResetOffer`, and the UI must show it before calling this —
 * but the action does not depend on that, because a forged POST would skip it.
 * What the action depends on is the same tenant scoping every other write here
 * carries: a foreign or public id reaches nothing.
 *
 * This is the ONLY path by which catalogue text can overwrite an installed
 * copy. Nothing schedules it, nothing calls it on page load, and the install
 * action does not refresh an existing clone — so an edited skill is never
 * silently overwritten when the public one moves on.
 */
export async function resetSkillToCatalogAction(skillId: string): Promise<SkillActionResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const id = IdInput.safeParse(skillId);
  if (!id.success) return { ok: false, error: "skill not found in this workspace" };

  const result = await resetOwnedSkillToUpstream(supabaseService(), { id: id.data, tenantId });
  if (!result.ok) return { ok: false, error: result.error };

  revalidateSkillSurfaces();
  revalidatePath(`/marketplace/${id.data}/edit`);
  return { ok: true, id: result.id };
}
