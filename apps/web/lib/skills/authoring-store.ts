// DB write/read half for operator-authored skills.
//
// ── Why a plain module (no `server-only`, no session) ──────────────────────
// Every function takes an injected `SupabaseClient` and an already-resolved
// `tenantId`, so the whole path is unit-testable with a filter-applying fake —
// the same DI split `lib/learning/write.ts` / `actions.ts` and
// `lib/roles/overlay-store.ts` use. The `"use server"` wrapper
// (`lib/skills/authoring-actions.ts`) derives `tenantId` from the SESSION and
// passes the client; it never re-implements the SQL.
//
// This module MUST NOT become a `"use server"` file: every export here takes a
// raw `tenantId`, and in a `"use server"` file every export is a
// browser-callable endpoint — which would publish a cross-tenant skill writer.
// That is precisely why `createTicketCore` lives in `lib/` and not in
// `board/actions.ts`.
//
// ── Tenant scope ───────────────────────────────────────────────────────────
// These run on the SERVICE client (RLS off), so the co-located
// `.eq("tenant_id", tenantId)` on EVERY read and write is the ENTIRE boundary.
// Two things ride on it and they fail in different directions:
//
//   • a missing predicate on a WRITE lets a caller edit or delete another
//     workspace's skill — and since a skill body is spliced into that
//     workspace's agents' system prompts on their next dispatch, that is not
//     merely a data-integrity bug but a way to put words in someone else's
//     agent's mouth;
//   • a missing predicate on a READ shows one workspace another's private
//     operating guidance.
//
// A third rule is enforced independently of the tenant predicate and is the one
// the task text calls out: NO path here can write a PUBLIC row. `tenant_id` is
// never taken from a caller-supplied field — it is always the resolved session
// tenant — and `assertOwnedRow` refuses a row whose `tenant_id` is null before
// any update or delete. The database says the same thing a second time: the M11
// policies `skills_member_insert/_update/_delete` all carry
// `tenant_id is not null and tenant_id in current_user_tenants()`. We do not
// rely on that here (the service client bypasses RLS), but it means a future
// caller reaching this table on an RLS-bound client inherits the rule for free.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SkillDraft } from "@/lib/skills/authoring";
import type { SkillManifest, SkillRow } from "@/lib/skills/types";
import { stampSkillBaseline } from "@/lib/marketplace/skill-provenance";

const TABLE = "skills";

const COLUMNS =
  "id, tenant_id, name, version, manifest, body, targets, triggers, installed_from_skill_id, created_at";

export type StoreOk = { ok: true; id: string };
export type StoreErr = { ok: false; error: string; conflict?: "name_taken" };
export type StoreResult = StoreOk | StoreErr;

/**
 * Load one of THIS tenant's skills for editing.
 *
 * Scoped on both `id` AND `tenant_id`, so a foreign id — including a PUBLIC
 * marketplace id, whose `tenant_id` is null and therefore matches no tenant —
 * returns null rather than a row the editor would then happily render in an
 * edit form and offer to save.
 */
export async function loadOwnedSkill(
  db: SupabaseClient,
  args: { id: string; tenantId: string },
): Promise<SkillRow | null> {
  const { data, error } = await db
    .from(TABLE)
    .select(COLUMNS)
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as SkillRow;
}

/** Every skill this tenant owns, newest first. */
export async function listOwnedSkills(
  db: SupabaseClient,
  args: { tenantId: string },
): Promise<SkillRow[]> {
  const { data, error } = await db
    .from(TABLE)
    .select(COLUMNS)
    .eq("tenant_id", args.tenantId)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data as unknown as SkillRow[];
}

/**
 * Is this name already used by a DIFFERENT skill in this tenant?
 *
 * Name-level, NOT (name, version)-level, and that is the whole versioning
 * decision in one predicate — see `updateOwnedSkill` below for why two rows
 * sharing a name is a live bug rather than a tidiness concern.
 */
async function nameTaken(
  db: SupabaseClient,
  args: { tenantId: string; name: string; exceptId?: string },
): Promise<boolean> {
  const { data, error } = await db
    .from(TABLE)
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("name", args.name);
  if (error || !data) return false;
  return (data as { id: string }[]).some((r) => r.id !== args.exceptId);
}

/**
 * The manifest an authored-or-edited row carries.
 *
 * ── `verified` is always cleared; `author` is NOT always overwritten ───────
 *
 * `verified: false` is unconditional and stays that way. Whatever the text was
 * before, the row now contains characters nobody upstream reviewed, and a
 * catalogue rendering `manifest.verified` must not show a shield over it.
 *
 * `author`, though, used to be flattened to "This workspace" on EVERY save —
 * which erased the provenance of an installed clone. Tightening one sentence of
 * a first-party skill made it indistinguishable from something written here
 * from scratch, and that is exactly the confusion the operator asked not to
 * have later. So for a clone (`isClone`) the upstream author is PRESERVED and
 * the "you changed this" fact is carried by the divergence record instead,
 * which can say it without also destroying where the text came from. Only a
 * genuinely authored row claims this workspace as its author.
 */
function manifestFor(
  draft: SkillDraft,
  args: { previous?: SkillManifest; isClone: boolean },
): SkillManifest {
  const previous = args.previous ?? {};
  return {
    ...previous,
    summary: draft.summary,
    verified: false,
    author:
      args.isClone && typeof previous.author === "string" ? previous.author : "This workspace",
  };
}

/**
 * Create a new skill owned by this tenant.
 *
 * `tenant_id` is the resolved session tenant, always — there is no code path
 * here that writes a null (public) `tenant_id`, and the input type carries no
 * field that could ask for one.
 */
export async function createOwnedSkill(
  db: SupabaseClient,
  args: { tenantId: string; draft: SkillDraft },
): Promise<StoreResult> {
  if (await nameTaken(db, { tenantId: args.tenantId, name: args.draft.name })) {
    return {
      ok: false,
      conflict: "name_taken",
      error:
        `You already have a skill called "${args.draft.name}". Edit that one, or pick a ` +
        `different name — two skills sharing a name would both be considered for the same ` +
        `dispatch and could contradict each other in one prompt.`,
    };
  }

  const { data, error } = await db
    .from(TABLE)
    .insert({
      tenant_id: args.tenantId,
      name: args.draft.name,
      version: args.draft.version,
      manifest: manifestFor(args.draft, { isClone: false }),
      body: args.draft.body,
      targets: args.draft.targets,
      triggers: args.draft.triggers,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "could not create the skill" };
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Refuse anything that is not a live row of THIS tenant. Split out so the
 * update and delete paths cannot diverge on it.
 *
 * The null-tenant clause is not redundant with the `.eq("tenant_id", …)` in
 * `loadOwnedSkill`: it is the second, independent statement of "a member never
 * writes a public row", positioned so that it holds even if a future caller
 * hands this function a row it loaded some other way.
 */
function assertOwnedRow(row: SkillRow | null, tenantId: string): StoreErr | null {
  if (!row) return { ok: false, error: "skill not found in this workspace" };
  if (row.tenant_id === null) {
    return {
      ok: false,
      error:
        "That is a marketplace skill, which belongs to the public catalogue and cannot be " +
        "edited here. Install it, then edit your own copy.",
    };
  }
  if (row.tenant_id !== tenantId) return { ok: false, error: "skill not found in this workspace" };
  return null;
}

/**
 * Edit a skill IN PLACE — same row, same id, fields overwritten.
 *
 * ── The versioning decision, and why in-place rather than a version bump ───
 *
 * The alternative considered was: an edit inserts a NEW row at a bumped
 * version and keeps the old one, so the history of what each dispatch saw is
 * preserved in the table. It was rejected for two reasons, the first of which
 * is a live bug rather than a preference.
 *
 * 1. `selectSkillsForDispatch` HAS NO NOTION OF "LATEST". It loads every row
 *    where `tenant_id = <caller>` and keyword-filters them; nothing anywhere
 *    groups by name or picks a maximum version. So two rows named
 *    `staging-smoke-check` at 1.0.0 and 1.1.0 are two independent candidates,
 *    both eligible, and `renderSkillsBlock` would merge BOTH into one system
 *    prompt — the operator's superseded guidance and its replacement sitting
 *    adjacent, contradicting each other, under a fence that tells the model to
 *    follow them. Auto-versioning would therefore not preserve history; it
 *    would corrupt the present. Making it safe means teaching selection to
 *    pick a latest version, and `lib/skills/select.ts` is a dispatch-path file
 *    this change does not own.
 *
 * 2. THE HISTORY ALREADY EXISTS, and in a better place. What a given run
 *    actually saw is the composed prompt recorded on that run's
 *    `run_steps.payload.systemPrompt`, fence, version label and all. That
 *    record is immutable and is unaffected by a later edit, so an in-place
 *    edit loses no audit trail — it only declines to keep a second, weaker
 *    copy of one in a table whose readers would then misinterpret it.
 *
 * `version` therefore stays an operator-owned LABEL that edits like any other
 * field. Bumping it while editing relabels the same row; it does not fork. An
 * operator who genuinely wants two coexisting variants creates two skills with
 * two names, which is the shape selection can actually represent.
 *
 * ── The name-collision guard is the other half of that decision ───────────
 *
 * Because two same-named rows are the failure above, `nameTaken` is checked at
 * NAME level and not at (name, version). The database's
 * `unique (tenant_id, name, version)` would only have caught the exact-version
 * case and waved the far more likely one through.
 */
export async function updateOwnedSkill(
  db: SupabaseClient,
  args: { id: string; tenantId: string; draft: SkillDraft; now?: () => string },
): Promise<StoreResult> {
  const existing = await loadOwnedSkill(db, { id: args.id, tenantId: args.tenantId });
  const refusal = assertOwnedRow(existing, args.tenantId);
  if (refusal) return refusal;

  if (
    await nameTaken(db, {
      tenantId: args.tenantId,
      name: args.draft.name,
      exceptId: args.id,
    })
  ) {
    return {
      ok: false,
      conflict: "name_taken",
      error:
        `Another of your skills is already called "${args.draft.name}". Two skills sharing a ` +
        `name would both be considered for the same dispatch and could contradict each other ` +
        `in one prompt.`,
    };
  }

  const sourceId = existing?.installed_from_skill_id ?? null;
  let manifest = manifestFor(args.draft, {
    previous: existing?.manifest ?? undefined,
    isClone: sourceId !== null,
  });

  // Record the baseline, for CLONES only. An authored row has no upstream, so a
  // record on one would describe a comparison that cannot be made.
  //
  // Both outcomes are a WRITE, and that is the point — `editedAt: null` is a
  // positive statement that this copy currently IS the catalogue text, not an
  // absence of information. Deleting the record on a hand-revert would instead
  // say "we know nothing about this copy", which is both false and the state
  // from which a later catalogue update is unattributable. See `SkillBaseline`.
  //
  // A failed upstream read leaves the previous record untouched rather than
  // guessing. Losing it would silently reclassify an edited clone as
  // `diverged_unknown`, a worse answer than the one already held.
  if (sourceId) {
    const upstream = await loadUpstreamSkill(db, { id: sourceId });
    if (upstream) {
      manifest = stampSkillBaseline(manifest, {
        editedAt:
          args.draft.body === upstream.body
            ? null
            : (args.now ?? (() => new Date().toISOString()))(),
        upstreamVersion: upstream.version,
        upstreamBody: upstream.body,
      });
    }
  }

  const { data, error } = await db
    .from(TABLE)
    .update({
      name: args.draft.name,
      version: args.draft.version,
      manifest,
      body: args.draft.body,
      targets: args.draft.targets,
      triggers: args.draft.triggers,
    })
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "skill not found in this workspace" };
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Read a PUBLIC catalogue row by id.
 *
 * `.is("tenant_id", null)` is not decoration and is not interchangeable with an
 * `.eq`: it is what stops a tenant id being passed here and resolving to a
 * private row, whose body would then be rendered as "the catalogue version" and
 * offered for adoption. `= NULL` is never true in SQL, so an `.eq` here would
 * instead return nothing at all and silently disable every provenance signal on
 * the page — a failure that looks like "no updates available".
 *
 * Read-only, always: nothing in this module or anywhere else writes a row
 * matching this predicate.
 */
export async function loadUpstreamSkill(
  db: SupabaseClient,
  args: { id: string },
): Promise<SkillRow | null> {
  const { data, error } = await db
    .from(TABLE)
    .select(COLUMNS)
    .eq("id", args.id)
    .is("tenant_id", null)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as SkillRow;
}

/**
 * Replace this workspace's copy with the catalogue's CURRENT text.
 *
 * ── Why reset and "take the update" are one function ──────────────────────
 *
 * They are the same write: overwrite the tenant's row from the public source
 * and clear the divergence record. Splitting them into two code paths would
 * mean two chances to diverge on which fields are copied, over a distinction
 * that exists only in what the operator is giving up — which belongs in the
 * confirmation text (`describeCatalogResetOffer`), not in the SQL.
 *
 * It copies the WHOLE row, not just the body: version, targets and triggers all
 * decide when and how the skill fires, so restoring the body alone would leave
 * a copy that reads like the catalogue's and behaves like something else.
 *
 * The one field it deliberately does NOT copy is `name`. A name is this
 * workspace's dedupe key — `nameTaken` rejects two rows sharing one because
 * both would be merged into a single prompt — so adopting a renamed catalogue
 * entry could collide with another installed skill and turn a reset into a
 * broken dispatch. The name is also the least consequential field: it is a
 * one-line label above the body, not guidance.
 *
 * ── This is the ONLY way catalogue text reaches an installed copy ─────────
 *
 * There is no scheduled job, no page-load refresh and no install-time
 * overwrite. This function runs when, and only when, the operator asks for it.
 * That is the answer to "what happens to an edited copy when the public skill
 * ships a new version": nothing, until he says so.
 *
 * Scoped on `id` AND `tenant_id`, exactly like every other write here, so a
 * foreign or public id updates nothing and reports that it did nothing. The
 * public source is read through `loadUpstreamSkill` and never written.
 */
export async function resetOwnedSkillToUpstream(
  db: SupabaseClient,
  args: { id: string; tenantId: string },
): Promise<StoreResult> {
  const existing = await loadOwnedSkill(db, { id: args.id, tenantId: args.tenantId });
  const refusal = assertOwnedRow(existing, args.tenantId);
  if (refusal) return refusal;

  const sourceId = existing?.installed_from_skill_id ?? null;
  if (!sourceId) {
    return {
      ok: false,
      error:
        "This skill was written in this workspace, so there is no catalogue version to reset to.",
    };
  }

  const upstream = await loadUpstreamSkill(db, { id: sourceId });
  if (!upstream) {
    return {
      ok: false,
      error:
        "The catalogue skill this was installed from is no longer listed, so there is nothing " +
        "to reset to. Your copy is unchanged.",
    };
  }

  const { data, error } = await db
    .from(TABLE)
    .update({
      version: upstream.version,
      // The upstream manifest, re-baselined against the text just copied. NOT
      // cleared: after this write the copy provably IS `upstream.body`, and
      // recording that is what lets a LATER catalogue change be reported as the
      // catalogue's doing rather than as an unattributable difference. An
      // `editedAt` carried over from the upstream row would be worse still — it
      // would describe an edit that no longer exists.
      manifest: stampSkillBaseline(upstream.manifest, {
        editedAt: null,
        upstreamVersion: upstream.version,
        upstreamBody: upstream.body,
      }),
      body: upstream.body,
      targets: upstream.targets,
      triggers: upstream.triggers,
    })
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "skill not found in this workspace" };
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Delete a skill this tenant owns.
 *
 * ── Delete, not archive, and the reason is not laziness ───────────────────
 *
 * An archive flag would need a column (a migration this feature otherwise does
 * not need) AND a `.neq("status","archived")` in `selectSkillsForDispatch` —
 * and that file is on the dispatch path and is not ours to change. Shipping the
 * column without the filter is the worst of the three options available: the
 * UI would say a skill is archived while it kept being merged into every
 * matching prompt, which is a lie told by a safety affordance. Between "delete
 * for real" and "pretend to stop", delete is the honest one.
 *
 * Nothing dangles. `skills.installed_from_skill_id` is
 * `on delete set null`, and in practice points only at PUBLIC rows anyway
 * (installs clone from the marketplace), so removing a tenant's own skill
 * orphans no install. Past dispatches keep their record: the body they used is
 * on `run_steps.payload.systemPrompt`, not fetched from this row.
 *
 * The scope is `id` AND `tenant_id`, so a foreign or public id deletes nothing
 * and says so, rather than reporting a success it did not perform.
 */
export async function deleteOwnedSkill(
  db: SupabaseClient,
  args: { id: string; tenantId: string },
): Promise<{ ok: true } | StoreErr> {
  const { data, error } = await db
    .from(TABLE)
    .delete()
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || (data as unknown[]).length === 0) {
    return { ok: false, error: "skill not found in this workspace" };
  }
  return { ok: true };
}

/**
 * Public (marketplace) skills sharing a name with one of this tenant's own.
 *
 * ── Can a tenant skill shadow a first-party one? ──────────────────────────
 *
 * At DISPATCH, no: `selectSkillsForDispatch` reads only `tenant_id = <caller>`
 * rows, so a public skill has no runtime effect until it is INSTALLED — and
 * installing is what makes a tenant-owned copy of it. So an operator naming his
 * own skill `code-review` while a first-party `code-review` sits unbrowsed in
 * the catalogue shadows nothing and is allowed; forbidding it would let the
 * public catalogue reserve names inside a workspace it cannot see.
 *
 * The collision is real only if he then INSTALLS the same-named public skill,
 * at which point his tenant holds two same-named rows and both are merged into
 * one prompt — the exact failure `nameTaken` exists to prevent. Install is the
 * sibling crew's path and is not ours to gate, and the database's
 * `unique (tenant_id, name, version)` only catches it when the versions also
 * match. So we do the thing we can do honestly from here: WARN at authoring
 * time, naming the catalogue skill, and let the operator decide. A refusal
 * would be worse — it would block a name over a skill he may never install.
 */
export async function findPublicNameClash(
  db: SupabaseClient,
  args: { name: string },
): Promise<{ name: string; version: string } | null> {
  const { data, error } = await db
    .from(TABLE)
    .select("name, version")
    .is("tenant_id", null)
    .eq("name", args.name)
    .maybeSingle();
  if (error || !data) return null;
  return data as { name: string; version: string };
}
