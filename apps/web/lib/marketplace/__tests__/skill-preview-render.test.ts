// Render tests for the review surface.
//
// These render the REAL components with `renderToStaticMarkup` under the repo's
// node-environment Vitest — no jsdom, no React Testing Library. That is why
// <SkillPreview> and <SkillEditLink> are plain presentational components with
// no Radix primitives and no browser API: the Dialog wrapper lives in
// `catalog.tsx` (which imports "use server" actions and so cannot load here),
// and everything worth asserting lives on this side of that line.
//
// What these prove, and why each one matters, is the marketplace's standing
// instruction: "review the body before installing". If the panel does not show
// the full body, or mis-states which roles a skill attaches to, that
// instruction is decoration.

import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillPreview } from "@/components/marketplace/skill-preview";
import { SkillEditLink } from "@/components/marketplace/skill-edit-link";
import type { SkillRow } from "@/lib/skills/types";

function skill(patch: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "s1",
    tenant_id: null,
    name: "Deploy checklist",
    version: "1.2.0",
    manifest: { summary: "Checks before a production deploy.", verified: true },
    body: "Always confirm the staging URL loads before reporting success.",
    targets: ["devops"],
    triggers: ["deploy", "vercel"],
    installed_from_skill_id: null,
    created_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

const labelFor = (slug: string) => ({ devops: "DevOps", qa: "QA" })[slug] ?? slug;

function renderPreview(row: SkillRow, installed: SkillRow | null = null): string {
  return renderToStaticMarkup(
    React.createElement(SkillPreview, { skill: row, installed, labelFor }),
  );
}

describe("SkillPreview — a public skill", () => {
  const html = renderPreview(skill());

  it("shows the whole body, not a truncated blurb", () => {
    expect(html).toContain("Always confirm the staging URL loads before reporting success.");
  });

  it("names the roles it attaches to, with catalog display names", () => {
    expect(html).toContain("DevOps");
  });

  it("surfaces the trigger words that make it fire", () => {
    // Triggers are half the selection rule and were previously shown nowhere,
    // which made "when does this fire" unanswerable from the UI.
    expect(html).toContain("deploy");
    expect(html).toContain("vercel");
  });

  it("states what installing changes", () => {
    expect(html).toContain("Copies this row into your tenant");
    expect(html).toContain("cannot grant tools");
  });

  it("does not claim a comparison it cannot make", () => {
    expect(html).not.toContain("installed copy differs");
    expect(html).not.toContain("matches this body exactly");
  });
});

describe("SkillPreview — reach", () => {
  it("says EVERY ROLE for a skill with no targets", () => {
    // The inversion this fixes: an empty targets array is the broadest reach in
    // the catalog, and the old card rendered nothing at all for it.
    const html = renderPreview(skill({ targets: [] }));
    expect(html).toContain("Every role");
    expect(html).toContain("no role targets");
  });

  it("says so when a skill has no trigger narrowing", () => {
    const html = renderPreview(skill({ triggers: [] }));
    expect(html).toContain("eligible on role alone");
  });
});

describe("SkillPreview — a tenant-owned skill", () => {
  it("renders a tenant-authored row's own body", () => {
    const authored = skill({
      tenant_id: "t1",
      installed_from_skill_id: null,
      body: "House rule: never force-push a shared branch.",
    });
    const html = renderPreview(authored);
    expect(html).toContain("House rule: never force-push a shared branch.");
  });
});

describe("SkillPreview — an installed skill", () => {
  it("confirms parity when the installed copy matches", () => {
    const pub = skill();
    const clone = skill({ id: "c1", tenant_id: "t1", installed_from_skill_id: "s1" });
    const html = renderPreview(pub, clone);
    expect(html).toContain("matches this body exactly");
  });

  it("flags drift AND shows the body agents actually receive", () => {
    // The "Installed" pill implies parity. When the public row moved on (or the
    // clone was edited) the operator is reviewing text that is not what runs,
    // and had no way to find that out.
    const pub = skill({ body: "PUBLIC VERSION TWO" });
    const clone = skill({
      id: "c1",
      tenant_id: "t1",
      version: "1.1.0",
      installed_from_skill_id: "s1",
      body: "OLD INSTALLED VERSION ONE",
    });
    const html = renderPreview(pub, clone);
    expect(html).toContain("does not match this public body");
    expect(html).toContain("Your copy is what agents actually receive");
    expect(html).toContain("OLD INSTALLED VERSION ONE");
    expect(html).toContain("PUBLIC VERSION TWO");
    expect(html).not.toContain("matches this body exactly");
  });
});

describe("SkillPreview — a long body", () => {
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(120)}`).join("\n");
  const html = renderPreview(skill({ body: long }));

  it("renders the body in full rather than clipping it in the markup", () => {
    expect(html).toContain("line 0 ");
    expect(html).toContain("line 399 ");
  });

  it("keeps it inside its own scroll container so the page cannot scroll sideways", () => {
    // The overflow contract. `overflow-auto` scopes the scrolling to this pane;
    // `break-words` + `whitespace-pre-wrap` stop a single unbroken 120-char run
    // from widening the document; the height cap stops the dialog growing
    // without bound.
    expect(html).toContain("overflow-auto");
    expect(html).toContain("break-words");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("max-h-[45vh]");
    // Nothing on this surface may pin a width to the viewport — the old footer
    // preview used `max-w-[90vw]` inside a grid cell, which is exactly how a
    // nested pane pushes the page wide.
    expect(html).not.toContain("vw]");
  });

  it("tells the operator how much text they are about to accept", () => {
    expect(html).toMatch(/characters/);
    expect(html).toMatch(/lines/);
  });
});

describe("SkillEditLink — offered only for rows this tenant owns", () => {
  it("renders an Edit link for a tenant-owned skill", () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillEditLink, {
        skill: { id: "own-1", tenant_id: "t1" },
        tenantId: "t1",
      }),
    );
    expect(html).toContain("Edit");
    expect(html).toContain("/marketplace/own-1/edit");
  });

  it("renders NOTHING for a public skill", () => {
    // Public rows are read-only for everything but service_role. Offering Edit
    // would point at a route that cannot succeed.
    const html = renderToStaticMarkup(
      React.createElement(SkillEditLink, {
        skill: { id: "pub-1", tenant_id: null },
        tenantId: "t1",
      }),
    );
    expect(html).toBe("");
  });

  it("renders NOTHING for another tenant's skill", () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillEditLink, {
        skill: { id: "foreign-1", tenant_id: "t2" },
        tenantId: "t1",
      }),
    );
    expect(html).toBe("");
  });

  it("renders NOTHING when no tenant is resolved", () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillEditLink, {
        skill: { id: "own-1", tenant_id: "t1" },
        tenantId: null,
      }),
    );
    expect(html).toBe("");
  });
});
