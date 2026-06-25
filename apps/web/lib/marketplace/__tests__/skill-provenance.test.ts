// The provenance rules for an edited installed skill.
//
// The property under test throughout is that "I edited this" and "the catalogue
// changed" are told APART. Before this module they were one signal, and a single
// signal covering two causes with opposite remedies is worse than no signal: an
// operator who edits one skill earns a permanent warning on it, learns the
// warning means nothing, and then misses the real upstream change.
//
// So every assertion below distinguishes states rather than merely observing
// that something differs, and each guard has a control showing the classifier
// would land somewhere else without it.

import { describe, expect, it } from "vitest";
import {
  classifySkillProvenance,
  describeCatalogResetOffer,
  describeSkillProvenance,
  readSkillBaseline,
  SKILL_BASELINE_KEY,
  stampSkillBaseline,
} from "@/lib/marketplace/skill-provenance";
import type { SkillManifest } from "@/lib/skills/types";

const UPSTREAM_V1 = "Always run the smoke suite before handing off.";
const UPSTREAM_V2 = "Always run the smoke suite and the contract tests before handing off.";
const EDITED = "Always run the smoke suite against staging.devpilot.dev before handing off.";

const SOURCE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A clone that has been edited, carrying the baseline `stampSkillBaseline` writes. */
function editedClone(opts: { body?: string; upstreamBody?: string } = {}) {
  return {
    body: opts.body ?? EDITED,
    installed_from_skill_id: SOURCE_ID,
    manifest: stampSkillBaseline(
      { summary: "smoke checks", author: "DevPilot first-party", verified: false },
      {
        editedAt: "2026-07-10T09:00:00.000Z",
        upstreamVersion: "1.0.0",
        upstreamBody: opts.upstreamBody ?? UPSTREAM_V1,
      },
    ),
  };
}

/**
 * A clone the operator has NOT edited, carrying a synced baseline — the shape a
 * reset leaves behind. `editedAt: null` is a positive statement of sync, which
 * is what makes a later catalogue change attributable to the catalogue.
 */
function syncedClone(opts: { upstreamBody?: string } = {}) {
  const body = opts.upstreamBody ?? UPSTREAM_V1;
  return {
    body,
    installed_from_skill_id: SOURCE_ID,
    manifest: stampSkillBaseline(
      { summary: "smoke checks" },
      { editedAt: null, upstreamVersion: "1.0.0", upstreamBody: body },
    ),
  };
}

describe("the edit record round-trips, and refuses to be half-trusted", () => {
  it("stamps and reads back", () => {
    const m = stampSkillBaseline(
      { summary: "s" },
      { editedAt: "2026-07-10T09:00:00.000Z", upstreamVersion: "1.0.0", upstreamBody: UPSTREAM_V1 },
    );
    expect(readSkillBaseline(m)).toEqual({
      editedAt: "2026-07-10T09:00:00.000Z",
      upstreamVersion: "1.0.0",
      upstreamBody: UPSTREAM_V1,
    });
  });

  it("preserves the rest of the manifest", () => {
    const m = stampSkillBaseline(
      { summary: "s", author: "DevPilot first-party", verified: false },
      { editedAt: "t", upstreamVersion: "1.0.0", upstreamBody: UPSTREAM_V1 },
    );
    expect(m.summary).toBe("s");
    expect(m.author).toBe("DevPilot first-party");
  });

  it("clears the record on null, leaving everything else", () => {
    const stamped = stampSkillBaseline(
      { summary: "s" },
      { editedAt: "t", upstreamVersion: "1.0.0", upstreamBody: UPSTREAM_V1 },
    );
    const cleared = stampSkillBaseline(stamped, null);
    expect(cleared[SKILL_BASELINE_KEY]).toBeUndefined();
    expect(cleared.summary).toBe("s");
    expect(readSkillBaseline(cleared)).toBeNull();
  });

  it("does not mutate the manifest it was handed", () => {
    const original: SkillManifest = { summary: "s" };
    stampSkillBaseline(original, { editedAt: "t", upstreamVersion: "1", upstreamBody: "x" });
    expect(original[SKILL_BASELINE_KEY]).toBeUndefined();
  });

  it("REFUSES a record with no upstream body", () => {
    // A record missing the upstream text cannot answer the only question it
    // exists to answer. Reading it as present would report every clone as
    // up-to-date against a catalogue it was never compared with.
    expect(
      readSkillBaseline({
        [SKILL_BASELINE_KEY]: { edited_at: "t", upstream_version: "1.0.0" },
      }),
    ).toBeNull();
  });

  it("REFUSES malformed shapes rather than partially trusting them", () => {
    for (const bad of [
      undefined,
      null,
      {},
      { [SKILL_BASELINE_KEY]: "yes" },
      {
        [SKILL_BASELINE_KEY]: [1, 2],
      },
    ]) {
      expect(readSkillBaseline(bad as SkillManifest)).toBeNull();
    }
  });
});

describe("classification — the four states that matter", () => {
  it("a row with no upstream is AUTHORED, whatever its body says", () => {
    const p = classifySkillProvenance(
      { body: EDITED, manifest: {}, installed_from_skill_id: null },
      { body: UPSTREAM_V1, version: "1.0.0" },
    );
    expect(p.kind).toBe("authored");
    expect(p.upstreamVersion).toBeNull();
  });

  it("an untouched clone is PRISTINE", () => {
    const p = classifySkillProvenance(
      { body: UPSTREAM_V1, manifest: { summary: "s" }, installed_from_skill_id: SOURCE_ID },
      { body: UPSTREAM_V1, version: "1.0.0" },
    );
    expect(p.kind).toBe("pristine");
    expect(p.editedHere).toBe(false);
    expect(p.upstreamMoved).toBe(false);
  });

  it("an edited clone with an unchanged catalogue is EDITED — and not a warning", () => {
    const p = classifySkillProvenance(editedClone(), { body: UPSTREAM_V1, version: "1.0.0" });
    expect(p.kind).toBe("edited");
    expect(p.editedHere).toBe(true);
    expect(p.upstreamMoved).toBe(false);
    // The behavioural half of the fix: adapting a skill to your own stack is the
    // supported workflow, so it must not sit under a permanent amber flag.
    expect(describeSkillProvenance(p).needsAttention).toBe(false);
  });

  it("an UNEDITED clone whose catalogue moved is UPSTREAM_CHANGED, not 'edited'", () => {
    // The operator changed nothing. Blaming him for the difference is the
    // inversion the single 'differs' signal used to produce.
    const p = classifySkillProvenance(syncedClone(), { body: UPSTREAM_V2, version: "2.0.0" });
    expect(p.kind).toBe("upstream_changed");
    expect(p.editedHere).toBe(false);
    expect(p.upstreamMoved).toBe(true);
    expect(describeSkillProvenance(p).needsAttention).toBe(true);
  });

  it("a synced clone with an unmoved catalogue is PRISTINE", () => {
    const p = classifySkillProvenance(syncedClone(), { body: UPSTREAM_V1, version: "1.0.0" });
    expect(p.kind).toBe("pristine");
  });

  it("`upstream_changed` is REACHABLE — the synced baseline is what makes it so", () => {
    // Recorded because the first cut of this module tracked only edits, which
    // left `upstream_changed` describable in prose and producible by no input:
    // an unedited clone had no record, so a first-party update was
    // indistinguishable from a pre-tracking edit and fell to
    // `diverged_unknown`. The CONTROL is the same clone WITHOUT the baseline.
    const withBaseline = classifySkillProvenance(syncedClone(), {
      body: UPSTREAM_V2,
      version: "2.0.0",
    });
    const without = classifySkillProvenance(
      { body: UPSTREAM_V1, manifest: { summary: "s" }, installed_from_skill_id: SOURCE_ID },
      { body: UPSTREAM_V2, version: "2.0.0" },
    );
    expect(withBaseline.kind).toBe("upstream_changed");
    expect(without.kind).toBe("diverged_unknown");
  });

  it("A NEWER CATALOGUE VERSION AFTER AN EDIT is its own state, and the edit is intact", () => {
    // This is the case the whole feature is designed around. The clone was
    // edited from v1; the catalogue has since shipped v2. Nothing has touched
    // the operator's copy, and the classifier reports BOTH facts rather than
    // collapsing them.
    const clone = editedClone({ upstreamBody: UPSTREAM_V1 });
    const p = classifySkillProvenance(clone, { body: UPSTREAM_V2, version: "2.0.0" });
    expect(p.kind).toBe("edited_upstream_changed");
    expect(p.editedHere).toBe(true);
    expect(p.upstreamMoved).toBe(true);
    expect(p.divergedFromVersion).toBe("1.0.0");
    expect(p.upstreamVersion).toBe("2.0.0");
    // The operator's text is still his. Classification reads; it never writes.
    expect(clone.body).toBe(EDITED);
  });

  it("CONTROL: with the catalogue still at v1 the same clone is merely EDITED", () => {
    // Proves the previous assertion turns on the RECORDED upstream body and not
    // on the mere existence of an edit record.
    const p = classifySkillProvenance(editedClone(), { body: UPSTREAM_V1, version: "1.0.0" });
    expect(p.kind).toBe("edited");
  });

  it("a difference with NO record is DIVERGED_UNKNOWN — never guessed either way", () => {
    // A clone edited before edit tracking shipped. Nothing anywhere records who
    // changed it. Guessing 'edited' blames the operator for a first-party
    // update; guessing 'upstream_changed' points him at a control that would
    // silently discard his own work.
    const p = classifySkillProvenance(
      { body: EDITED, manifest: { summary: "s" }, installed_from_skill_id: SOURCE_ID },
      { body: UPSTREAM_V1, version: "1.0.0" },
    );
    expect(p.kind).toBe("diverged_unknown");
    expect(p.editedHere).toBe(false);
    expect(p.upstreamMoved).toBe(false);
    expect(describeSkillProvenance(p).detail).toMatch(/did not record which side/i);
  });

  it("a clone whose source is gone is UPSTREAM_UNAVAILABLE, not a difference", () => {
    const p = classifySkillProvenance(editedClone(), null);
    expect(p.kind).toBe("upstream_unavailable");
    expect(describeSkillProvenance(p).needsAttention).toBe(false);
  });
});

describe("the wording is the feature — every state says something different", () => {
  it("no two states share a label", () => {
    const states = [
      classifySkillProvenance(
        { body: "b", manifest: {}, installed_from_skill_id: null },
        { body: "b", version: "1.0.0" },
      ),
      classifySkillProvenance(
        { body: UPSTREAM_V1, manifest: {}, installed_from_skill_id: SOURCE_ID },
        { body: UPSTREAM_V1, version: "1.0.0" },
      ),
      classifySkillProvenance(editedClone(), { body: UPSTREAM_V1, version: "1.0.0" }),
      classifySkillProvenance(syncedClone(), { body: UPSTREAM_V2, version: "2.0.0" }),
      classifySkillProvenance(editedClone(), { body: UPSTREAM_V2, version: "2.0.0" }),
      classifySkillProvenance(
        { body: EDITED, manifest: {}, installed_from_skill_id: SOURCE_ID },
        { body: UPSTREAM_V1, version: "1.0.0" },
      ),
      classifySkillProvenance(editedClone(), null),
    ];
    const labels = states.map((s) => describeSkillProvenance(s).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("states an operator can act on say so; states he cannot do not", () => {
    const actionable = ["upstream_changed", "edited_upstream_changed", "diverged_unknown"];
    for (const kind of [
      "authored",
      "pristine",
      "edited",
      "upstream_changed",
      "edited_upstream_changed",
      "diverged_unknown",
      "upstream_unavailable",
    ] as const) {
      const copy = describeSkillProvenance({
        kind,
        editedHere: false,
        upstreamMoved: false,
        upstreamVersion: "2.0.0",
        divergedFromVersion: "1.0.0",
        editedAt: null,
      });
      expect(copy.needsAttention, kind).toBe(actionable.includes(kind));
    }
  });

  it("the edited state promises the edit will not be overwritten", () => {
    // The product claim being made to the operator, pinned so a reworded copy
    // cannot quietly drop it.
    const p = classifySkillProvenance(editedClone(), { body: UPSTREAM_V1, version: "1.0.0" });
    expect(describeSkillProvenance(p).detail).toMatch(/nothing will overwrite/i);
  });
});

describe("the reset offer", () => {
  it("is NOT offered where it would do nothing or could not work", () => {
    for (const kind of ["authored", "pristine", "upstream_unavailable"] as const) {
      const offer = describeCatalogResetOffer({
        kind,
        editedHere: false,
        upstreamMoved: false,
        upstreamVersion: null,
        divergedFromVersion: null,
        editedAt: null,
      });
      expect(offer.offered, kind).toBe(false);
    }
  });

  it("warns that a recorded edit is discarded, in every state that has one", () => {
    for (const kind of ["edited", "edited_upstream_changed"] as const) {
      const offer = describeCatalogResetOffer({
        kind,
        editedHere: true,
        upstreamMoved: kind === "edited_upstream_changed",
        upstreamVersion: "2.0.0",
        divergedFromVersion: "1.0.0",
        editedAt: null,
      });
      expect(offer.offered, kind).toBe(true);
      if (!offer.offered) return;
      expect(offer.discardsEdit, kind).toBe(true);
      expect(offer.warning, kind).toMatch(/discard|replaces your copy/i);
    }
  });

  it("labels 'reset' and 'take the update' differently even though the write is the same", () => {
    const reset = describeCatalogResetOffer({
      kind: "edited",
      editedHere: true,
      upstreamMoved: false,
      upstreamVersion: "1.0.0",
      divergedFromVersion: "1.0.0",
      editedAt: null,
    });
    const take = describeCatalogResetOffer({
      kind: "edited_upstream_changed",
      editedHere: true,
      upstreamMoved: true,
      upstreamVersion: "2.0.0",
      divergedFromVersion: "1.0.0",
      editedAt: null,
    });
    expect(reset.offered && take.offered).toBe(true);
    if (!reset.offered || !take.offered) return;
    expect(reset.label).not.toBe(take.label);
  });
});
