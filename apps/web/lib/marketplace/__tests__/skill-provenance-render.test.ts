// Render tests for the provenance surface on an installed skill card.
//
// Same shape and same constraint as `skill-preview-render.test.ts`: the REAL
// components under `renderToStaticMarkup` in node-environment Vitest, which is
// why these two carry no Radix primitive and no browser API. The confirmation
// dialog for the reset control stays in `catalog.tsx`, which imports
// "use server" actions and so cannot load here at all.
//
// What is being proven is a product claim, not a layout. The card previously
// rendered ONE warning — "Differs from the public vN" — for two situations
// whose right responses are opposite: the operator deliberately adapted the
// skill (nothing to do) and the catalogue moved on beneath him (worth reading).
// An operator with one edited skill therefore carried a permanent warning,
// which is how the signal stops being read. These assertions pin that the two
// now look and read differently.

import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SkillProvenanceBadge,
  SkillProvenanceNote,
} from "@/components/marketplace/skill-provenance-note";
import {
  classifySkillProvenance,
  stampSkillBaseline,
  type SkillProvenance,
} from "@/lib/marketplace/skill-provenance";
import type { SkillRow } from "@/lib/skills/types";

const SOURCE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CATALOG_V1 = "Confirm the staging URL loads before reporting success.";
const CATALOG_V2 = "Confirm the staging URL loads and the health check is green.";
const MY_TEXT = "Confirm https://staging.internal loads before reporting success.";

function clone(patch: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "s1",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    name: "deploy-checklist",
    version: "1.2.0",
    manifest: { summary: "Checks before a production deploy." },
    body: CATALOG_V1,
    targets: ["devops"],
    triggers: ["deploy"],
    installed_from_skill_id: SOURCE_ID,
    created_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

const render = (p: SkillProvenance) =>
  renderToStaticMarkup(
    React.createElement(React.Fragment, null, [
      React.createElement(SkillProvenanceBadge, { key: "b", provenance: p }),
      React.createElement(SkillProvenanceNote, { key: "n", provenance: p }),
    ]),
  );

/** Edited here, catalogue unchanged. */
const edited = classifySkillProvenance(
  clone({
    body: MY_TEXT,
    manifest: stampSkillBaseline(
      { summary: "s" },
      { editedAt: "2026-07-10T00:00:00Z", upstreamVersion: "1.2.0", upstreamBody: CATALOG_V1 },
    ),
  }),
  { body: CATALOG_V1, version: "1.2.0" },
);

/** Not edited, catalogue moved. */
const upstreamMoved = classifySkillProvenance(
  clone({
    manifest: stampSkillBaseline(
      { summary: "s" },
      { editedAt: null, upstreamVersion: "1.2.0", upstreamBody: CATALOG_V1 },
    ),
  }),
  { body: CATALOG_V2, version: "2.0.0" },
);

/** Edited here AND the catalogue moved. */
const both = classifySkillProvenance(
  clone({
    body: MY_TEXT,
    manifest: stampSkillBaseline(
      { summary: "s" },
      { editedAt: "2026-07-10T00:00:00Z", upstreamVersion: "1.2.0", upstreamBody: CATALOG_V1 },
    ),
  }),
  { body: CATALOG_V2, version: "2.0.0" },
);

const pristine = classifySkillProvenance(clone(), { body: CATALOG_V1, version: "1.2.0" });

describe("an edited copy is distinguishable from a pristine install", () => {
  it("says it was edited here", () => {
    expect(render(edited)).toContain("Edited here");
  });

  it("a pristine install does not", () => {
    const html = render(pristine);
    expect(html).not.toContain("Edited here");
    expect(html).toContain("Installed copy");
  });

  it("does NOT dress a deliberate edit as a warning", () => {
    // The behavioural half of the fix. `text-warning` is the amber treatment;
    // an edit is the supported workflow and must not wear it, or the operator
    // learns to ignore amber on this card.
    expect(render(edited)).not.toContain("text-warning");
    expect(render(upstreamMoved)).toContain("text-warning");
  });

  it("promises, in the card, that the edit will not be overwritten", () => {
    expect(render(edited)).toMatch(/nothing will overwrite/i);
  });
});

describe("'I edited it' and 'the catalogue moved' read differently", () => {
  it("the three non-pristine states render three different texts", () => {
    const rendered = [render(edited), render(upstreamMoved), render(both)];
    expect(new Set(rendered).size).toBe(3);
  });

  it("an upstream change is attributed to the catalogue, not to the operator", () => {
    const html = render(upstreamMoved);
    expect(html).toContain("Catalogue updated");
    expect(html).toMatch(/your copy is untouched/i);
    expect(html).not.toContain("Edited here");
  });

  it("the both-changed state names BOTH facts and both versions", () => {
    const html = render(both);
    expect(html).toMatch(/you edited this copy/i);
    expect(html).toMatch(/catalogue has since changed/i);
    expect(html).toContain("1.2.0");
    expect(html).toContain("2.0.0");
  });
});

describe("the boring cases stay quiet", () => {
  it("renders no note for a pristine clone or an authored skill", () => {
    for (const p of [
      pristine,
      classifySkillProvenance(clone({ installed_from_skill_id: null }), null),
    ]) {
      const note = renderToStaticMarkup(
        React.createElement(SkillProvenanceNote, { provenance: p }),
      );
      expect(note).toBe("");
    }
  });
});
