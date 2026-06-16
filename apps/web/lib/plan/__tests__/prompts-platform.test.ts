// WI-11 — the platform HARD frame in the shared project block.
//
// The frame is injected via `projectBlock`, which is private, so these assert
// through the public prompts that embed it. PANEL_PM + CONSOLIDATOR are the two
// that actually emit tickets, so they are the ones that must carry the frame.

import { describe, expect, it } from "vitest";
import {
  CONSOLIDATOR_PROMPT,
  PANEL_DEVOPS_PROMPT,
  PANEL_PM_PROMPT,
  PANEL_TECH_LEAD_PROMPT,
  type PromptContext,
} from "../prompts";

function ctx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    projectName: "acme",
    stackFlavor: "mixed",
    stackPreferences: "",
    // WI-15 — no committed stack pinned, and no ecosystem committed (stack
    // advisor), so no stack frame renders and these platform assertions stay
    // about the platform frame alone.
    stackTags: [],
    stackEcosystem: "unset",
    teamTier: "standard",
    ...over,
  };
}

const TICKET_EMITTING_PROMPTS = [
  ["PANEL_PM", PANEL_PM_PROMPT],
  ["PANEL_TECH_LEAD", PANEL_TECH_LEAD_PROMPT],
  ["PANEL_DEVOPS", PANEL_DEVOPS_PROMPT],
] as const;

describe("platform HARD frame", () => {
  it.each(TICKET_EMITTING_PROMPTS)("%s carries the frame for an asserted platform", (_n, p) => {
    const out = p(ctx({ projectType: "mobile" }));
    expect(out).toContain("Platform — HARD CONSTRAINT");
    expect(out).toContain("React Native / Expo / Flutter");
    expect(out).toContain("- Platform: **mobile**");
  });

  it("the consolidator carries it too — it emits the final ticket list", () => {
    const out = CONSOLIDATOR_PROMPT(ctx({ projectType: "ios" }));
    expect(out).toContain("Platform — HARD CONSTRAINT");
    expect(out).toContain("Swift / SwiftUI");
  });

  it("each platform frames itself, and names what it must NOT plan for", () => {
    expect(PANEL_PM_PROMPT(ctx({ projectType: "web" }))).toContain("native mobile screens");
    expect(PANEL_PM_PROMPT(ctx({ projectType: "desktop" }))).toContain("auto-update");
    expect(PANEL_PM_PROMPT(ctx({ projectType: "ios" }))).toContain("React Native, Expo, Flutter");
  });

  // The load-bearing default: `other` asserts no platform, so a pre-WI-11
  // project's prompt must be exactly what it was — no frame AND no bullet. A
  // default that quietly narrowed every legacy plan would be worse than no
  // feature at all.
  it("`other`, null, and absent all add nothing at all", () => {
    const baseline = PANEL_PM_PROMPT(ctx());
    for (const projectType of ["other", null, undefined] as const) {
      const out = PANEL_PM_PROMPT(ctx({ projectType }));
      expect(out).toBe(baseline);
      expect(out).not.toContain("HARD CONSTRAINT");
      expect(out).not.toContain("- Platform:");
    }
  });

  // Repo-derived text can contradict the operator's stated platform (a mobile
  // app whose README still describes the web prototype it grew out of). The
  // assertion must be what the model reads first.
  it("the frame precedes the README and package.json excerpts", () => {
    const out = PANEL_PM_PROMPT(
      ctx({
        projectType: "mobile",
        readmeExcerpt: "A Next.js web app.",
        packageJsonExcerpt: '{"name":"legacy-web"}',
      }),
    );
    expect(out.indexOf("Platform — HARD CONSTRAINT")).toBeLessThan(out.indexOf("README excerpt"));
    expect(out.indexOf("Platform — HARD CONSTRAINT")).toBeLessThan(
      out.indexOf("package.json excerpt"),
    );
  });
});
