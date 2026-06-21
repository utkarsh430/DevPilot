// What an EDIT to an installed skill means — the pure rules.
//
// PURE and browser-safe: no IO, no `server-only`, no `node:` import. The
// marketplace catalogue is a client component and renders these states, so
// anything unavailable in a browser bundle cannot live here. The DB half is
// `lib/skills/authoring-store.ts`.
//
// ── The thing that was already true, and the thing that was not ────────────
//
// `installSkillAction` COPIES the body into a tenant-owned row. An installed
// skill is therefore already the operator's own copy, fully detached from the
// public seed: `selectSkillsForDispatch` reads `skills WHERE tenant_id =
// <caller>` and never consults the public row, so editing a clone changes what
// this workspace's agents are told and changes nothing for anyone else. No fork
// mechanism was needed and none was built.
//
// What was missing is not the ability to edit. It is HONESTY ABOUT WHAT AN EDIT
// MEANS, and it was missing in three specific ways:
//
//   1. `compareWithInstalled` collapses two causes with opposite remedies into
//      one word. "differs" is returned both when the operator deliberately
//      adapted the skill to his stack (expected; nothing to do) and when the
//      public catalogue moved on underneath him (worth a look). The card
//      rendered both as the same amber warning, so an operator who edits one
//      skill earns a permanent warning on it — which is precisely the training
//      that makes him ignore the warning that would have told him about a real
//      upstream change.
//
//   2. Editing a clone ERASED its provenance. `manifestFor` stamped
//      `author: "This workspace"` on every save, so a first-party skill whose
//      wording you tightened by one sentence became indistinguishable from
//      something you wrote from scratch.
//
//   3. Nothing answered "the public skill later shipped a new version".
//
// ── The answer to the version question, stated plainly ─────────────────────
//
// NOTHING HAPPENS TO YOUR COPY. No code path in DevPilot writes a tenant's skill
// row from upstream — not on a schedule, not on page load, not on install (the
// install action refuses when a clone already exists rather than refreshing
// it). A newer public version is SURFACED as a notice and adopted only when the
// operator asks for it. Silently overwriting an operator's edits is the failure
// this feature exists to avoid, so the design does not merely decline to do it,
// it has nowhere to do it from.
//
// That guarantee is structural, but before this module it was also invisible —
// the operator had no way to see that the catalogue had changed, and so no way
// to benefit from the choice being his. These states are what make it visible.
//
// ── Why a recorded divergence point, and why the upstream text verbatim ────
//
// Telling "I edited it" apart from "the catalogue moved" cannot be done by
// comparing the two live bodies: both causes produce the same inequality. It
// needs one extra fact, recorded at the moment of divergence — the upstream
// text the edit was made FROM. `stampSkillBaseline` writes it into the manifest
// (jsonb, so no migration) when a CLONE is saved.
//
// Stored verbatim rather than as a hash for two reasons. A hash needs a hash
// function, and this module has to run in the browser. And the text is worth
// more than the comparison: it is what lets the UI say which catalogue version
// an edit was based on, and it costs at most `SKILL_BODY_MAX_CHARS` on the
// edited clones only.
//
// ── Divergence is tracked on the BODY ──────────────────────────────────────
//
// Not on targets, triggers or the summary. The body is the text that reaches
// the model, which is the same rule and the same rationale `compareWithInstalled`
// already applies one module over — so the two surfaces cannot disagree about
// what "differs" means. The consequence is stated rather than hidden: a
// targets-only edit leaves a clone `pristine`, and the copy for that state says
// "the body is unchanged" rather than the broader "unchanged" it would
// otherwise be entitled to claim.

import type { SkillManifest, SkillRow } from "@/lib/skills/types";

/** Manifest key holding the baseline record. Namespaced; the manifest is open-ended. */
export const SKILL_BASELINE_KEY = "devpilot_edit";

/**
 * The last point at which this copy and the catalogue were known to line up,
 * and whether the operator has since edited away from it.
 *
 * ── Why a BASELINE and not just an edit marker ────────────────────────────
 *
 * The first version of this recorded only edits, and that made
 * `upstream_changed` — a clone the operator never touched, whose catalogue
 * entry moved on — UNREACHABLE. An unedited clone has no record, so a later
 * first-party update left it looking exactly like a clone edited before edit
 * tracking existed: no record, bodies differ. Both fell to `diverged_unknown`,
 * and the single most common and most useful signal ("the catalogue updated,
 * come and look") could never fire. A state described in prose that no input
 * can produce is worse than no state.
 *
 * Generalising the record fixes it without touching the install path, which
 * belongs to another crew. Both writes this feature owns leave a baseline:
 *
 *   • an EDIT stamps `editedAt` — the copy has moved away from `upstreamBody`;
 *   • a RESET stamps `editedAt: null` — the copy IS `upstreamBody`, exactly.
 *
 * A `null` baseline is therefore a positive statement of sync, and a catalogue
 * change after one is unambiguously the catalogue's doing. A fresh install
 * still carries no record at all — that write is not ours — so it stays
 * `pristine` until the bodies diverge, at which point it honestly reports
 * `diverged_unknown` and self-heals on the first edit or reset.
 *
 * `upstreamBody` is the catalogue text at the baseline — NOT the current
 * catalogue text, which is the whole point: comparing the two is what detects a
 * later upstream change.
 */
export type SkillBaseline = {
  /** When the operator edited away from the baseline; null when the copy matches it. */
  editedAt: string | null;
  /** Catalogue version at the baseline. */
  upstreamVersion: string;
  /** Catalogue body at the baseline. */
  upstreamBody: string;
};

/**
 * Read the baseline back out of a manifest.
 *
 * Refuses anything malformed rather than partially trusting it: a record
 * missing `upstreamBody` cannot answer the only question it exists to answer,
 * and treating it as present would report a clone as reconciled against a
 * catalogue text it had never been compared with. Absent beats wrong — an
 * absent record degrades to `diverged_unknown`, which says out loud that we do
 * not know.
 *
 * `edited_at` is accepted as a string OR as an explicit null, and nothing else.
 * A missing key is refused rather than read as null, because "no edit" and "no
 * record" are the two facts this whole module exists to keep apart.
 */
export function readSkillBaseline(
  manifest: SkillManifest | null | undefined,
): SkillBaseline | null {
  const raw = manifest?.[SKILL_BASELINE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!("edited_at" in rec)) return null;
  const editedAt = rec.edited_at;
  if (editedAt !== null && !(typeof editedAt === "string" && editedAt.length > 0)) return null;
  if (typeof rec.upstream_body !== "string") return null;
  if (typeof rec.upstream_version !== "string") return null;
  return {
    editedAt: editedAt as string | null,
    upstreamVersion: rec.upstream_version,
    upstreamBody: rec.upstream_body,
  };
}

/**
 * Write (or remove) the baseline on a manifest, returning a new object.
 *
 * Pure so the store layer has no branching of its own to get wrong, and so the
 * round-trip `stamp → read` is provable without a database.
 */
export function stampSkillBaseline(
  manifest: SkillManifest | null | undefined,
  baseline: SkillBaseline | null,
): SkillManifest {
  const next: SkillManifest = { ...(manifest ?? {}) };
  if (baseline === null) {
    delete next[SKILL_BASELINE_KEY];
    return next;
  }
  next[SKILL_BASELINE_KEY] = {
    edited_at: baseline.editedAt,
    upstream_version: baseline.upstreamVersion,
    upstream_body: baseline.upstreamBody,
  };
  return next;
}

/**
 * How an installed row stands relative to the public catalogue.
 *
 *  - `authored`                — no upstream at all. This workspace wrote it.
 *  - `pristine`                — a clone that still matches the catalogue.
 *  - `edited`                  — edited here; the catalogue has not moved since.
 *  - `upstream_changed`        — NOT edited here; the catalogue moved on.
 *  - `edited_upstream_changed` — both. The only state that genuinely needs a
 *                                human to decide something.
 *  - `diverged_unknown`        — the bodies differ and no record says which side
 *                                changed. See below; this is not a placeholder.
 *  - `upstream_unavailable`    — a clone whose source row is gone from the
 *                                catalogue, so there is nothing to compare to.
 *
 * ── `diverged_unknown` is an honest state, not a gap ──────────────────────
 *
 * A clone edited BEFORE this feature shipped carries no divergence record, and
 * its body differs from the catalogue's. There is no fact anywhere that says
 * whether the operator changed it or the catalogue did — the information was
 * never recorded, and inferring one is a guess presented as provenance. Guessing
 * `edited` blames the operator for a first-party update he never saw; guessing
 * `upstream_changed` tells him the catalogue moved when it did not, and points
 * him at a "take the update" control that would silently discard his own work.
 *
 * So it reports exactly what is known — the bodies differ, the cause was not
 * recorded — which is what the old single "differs" signal actually meant all
 * along, now said out loud instead of implied. It self-heals: the next save or
 * reset writes a record and the row lands in a definite state thereafter.
 */
export type SkillProvenanceKind =
  | "authored"
  | "pristine"
  | "edited"
  | "upstream_changed"
  | "edited_upstream_changed"
  | "diverged_unknown"
  | "upstream_unavailable";

export type SkillProvenance = {
  kind: SkillProvenanceKind;
  /** True for every state where this workspace's text is known to be its own. */
  editedHere: boolean;
  /** True where the catalogue is known to have moved since the divergence point. */
  upstreamMoved: boolean;
  /** The catalogue's CURRENT version, when there is a live source row. */
  upstreamVersion: string | null;
  /** The catalogue version the edit was based on, when an edit was recorded. */
  divergedFromVersion: string | null;
  editedAt: string | null;
};

/**
 * Classify one installed row against its public source.
 *
 * `source` is the CURRENT catalogue row (null when it is gone, or when the
 * caller could not resolve it). The clone's own `installed_from_skill_id` is
 * what decides whether there is meant to be one at all — a null there means the
 * workspace authored this, and no amount of body comparison changes that.
 */
export function classifySkillProvenance(
  skill: Pick<SkillRow, "body" | "manifest" | "installed_from_skill_id">,
  source: Pick<SkillRow, "body" | "version"> | null | undefined,
): SkillProvenance {
  const base = {
    editedHere: false,
    upstreamMoved: false,
    upstreamVersion: source?.version ?? null,
    divergedFromVersion: null,
    editedAt: null,
  } satisfies Omit<SkillProvenance, "kind">;

  if (!skill.installed_from_skill_id) {
    return { ...base, kind: "authored", upstreamVersion: null };
  }
  if (!source) {
    return { ...base, kind: "upstream_unavailable", upstreamVersion: null };
  }

  const baseline = readSkillBaseline(skill.manifest);
  if (baseline) {
    const upstreamMoved = source.body !== baseline.upstreamBody;
    if (baseline.editedAt === null) {
      // The copy was reconciled with the catalogue and not edited since, so a
      // difference now is unambiguously the catalogue's doing.
      return {
        ...base,
        kind: upstreamMoved ? "upstream_changed" : "pristine",
        upstreamMoved,
        divergedFromVersion: baseline.upstreamVersion,
      };
    }
    return {
      ...base,
      kind: upstreamMoved ? "edited_upstream_changed" : "edited",
      editedHere: true,
      upstreamMoved,
      divergedFromVersion: baseline.upstreamVersion,
      editedAt: baseline.editedAt,
    };
  }

  if (skill.body === source.body) return { ...base, kind: "pristine" };

  // No record, and the bodies differ. We know that much and no more.
  return { ...base, kind: "diverged_unknown" };
}

/**
 * The operator-facing wording for each state.
 *
 * Lives here rather than in JSX because the sentences ARE the feature: the
 * whole defect being fixed is that one warning said two different things. A
 * test can pin wording; it cannot pin a template literal in a component.
 *
 * `tone` maps onto the existing badge vocabulary. Note `edited` is NEUTRAL, not
 * a warning: an operator adapting a skill to his own stack is the supported
 * workflow, and flagging it amber forever is how the genuinely-actionable
 * states get ignored.
 */
export type SkillProvenanceCopy = {
  label: string;
  tone: "muted" | "ok" | "violet" | "warn";
  /** One sentence stating what is true. Rendered as visible text, not a tooltip. */
  detail: string;
  /** True where there is a decision for the operator, and the card should say so. */
  needsAttention: boolean;
};

export function describeSkillProvenance(p: SkillProvenance): SkillProvenanceCopy {
  switch (p.kind) {
    case "authored":
      return {
        label: "Authored here",
        tone: "violet",
        detail: "Written in this workspace. It has no catalogue version to compare against.",
        needsAttention: false,
      };
    case "pristine":
      return {
        label: "Installed copy",
        tone: "ok",
        detail: `The body is unchanged since you installed it — it still matches the catalogue${
          p.upstreamVersion ? ` v${p.upstreamVersion}` : ""
        }.`,
        needsAttention: false,
      };
    case "edited":
      return {
        label: "Edited here",
        tone: "violet",
        detail: `Your copy — you changed it after installing${
          p.divergedFromVersion ? ` the catalogue v${p.divergedFromVersion}` : ""
        }. The catalogue has not changed since, and nothing will overwrite your edit.`,
        needsAttention: false,
      };
    case "upstream_changed":
      return {
        label: "Catalogue updated",
        tone: "warn",
        detail:
          `The catalogue version${
            p.upstreamVersion ? ` (now v${p.upstreamVersion})` : ""
          } has changed since you installed this. Your copy is untouched — review the new text and ` +
          `take it if you want it.`,
        needsAttention: true,
      };
    case "edited_upstream_changed":
      return {
        label: "Edited · catalogue updated",
        tone: "warn",
        detail: `You edited this copy${
          p.divergedFromVersion ? ` from the catalogue v${p.divergedFromVersion}` : ""
        }, and the catalogue has since changed too${
          p.upstreamVersion ? ` (now v${p.upstreamVersion})` : ""
        }. Your edit is intact. Taking the catalogue version would replace it.`,
        needsAttention: true,
      };
    case "diverged_unknown":
      return {
        label: "Differs from the catalogue",
        tone: "warn",
        detail:
          "This copy no longer matches the catalogue, and DevPilot did not record which side " +
          "changed — it predates edit tracking. Compare the two before replacing either.",
        needsAttention: true,
      };
    case "upstream_unavailable":
      return {
        label: "Catalogue entry gone",
        tone: "muted",
        detail:
          "The catalogue skill this was installed from is no longer listed. Your copy keeps " +
          "working exactly as it is.",
        needsAttention: false,
      };
  }
}

/**
 * Whether a "take the catalogue version" control should be offered, and what it
 * should be called.
 *
 * Reset-to-original and take-the-update are THE SAME WRITE — overwrite this
 * workspace's copy with the catalogue's current text — so they are one control,
 * labelled by state rather than duplicated as two buttons that do the same
 * thing and imply otherwise. What differs between the states is only what is
 * being given up, which is what the confirmation has to say.
 *
 * Not offered for `authored` (no upstream), `upstream_unavailable` (nothing to
 * take), or `pristine` (the copy already matches, so the button would be a
 * no-op dressed as an action).
 */
export type CatalogResetOffer =
  | { offered: false }
  | {
      offered: true;
      label: string;
      /** What the operator loses. Shown in the confirmation, never only in a title attribute. */
      warning: string;
      /** True when a recorded operator edit would be discarded. */
      discardsEdit: boolean;
    };

export function describeCatalogResetOffer(p: SkillProvenance): CatalogResetOffer {
  switch (p.kind) {
    case "authored":
    case "upstream_unavailable":
    case "pristine":
      return { offered: false };
    case "edited":
      return {
        offered: true,
        label: "Reset to the catalogue version",
        warning:
          "This replaces your copy with the catalogue text and discards the changes you made. " +
          "It cannot be undone from here.",
        discardsEdit: true,
      };
    case "upstream_changed":
      return {
        offered: true,
        label: "Take the catalogue version",
        warning:
          "This replaces your copy with the catalogue's current text. You have no recorded edits " +
          "to lose, but any change made before edit tracking would go too.",
        discardsEdit: false,
      };
    case "edited_upstream_changed":
      return {
        offered: true,
        label: "Take the catalogue version",
        warning:
          "This replaces your copy — including the edits you made — with the catalogue's current " +
          "text. It cannot be undone from here.",
        discardsEdit: true,
      };
    case "diverged_unknown":
      return {
        offered: true,
        label: "Take the catalogue version",
        warning:
          "This replaces your copy with the catalogue's current text. DevPilot cannot tell whether " +
          "the difference is an edit of yours, so read both before doing this.",
        discardsEdit: true,
      };
  }
}
