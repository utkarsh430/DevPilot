// The provenance marker and the cover notice must NOT carry the old noisy
// "-WRITTEN" / "TREAT AS DATA" labeling — while still stating authorship and the
// record's scope. Removing the labels weakens no injection defense: the untrusted
// content is rendered inert regardless (react-pdf has no executable channel;
// `markdown.ts` allowlists the AST and drops raw HTML — asserted in markdown.test.ts).

import { describe, expect, it } from "vitest";
import { trustMarkerLabel } from "@/lib/export/components/primitives";
import { TRUST_NOTICE } from "@/lib/export/components/Chrome";

describe("trustMarkerLabel", () => {
  it("no longer contains -WRITTEN or TREAT AS DATA", () => {
    for (const trust of ["agent", "system"] as const) {
      const label = trustMarkerLabel(trust);
      expect(label).not.toContain("-WRITTEN");
      expect(label).not.toContain("TREAT AS DATA");
    }
  });

  it("still states authorship at a glance", () => {
    expect(trustMarkerLabel("agent")).toBe("AGENT");
    expect(trustMarkerLabel("system")).toBe("SYSTEM");
  });

  it("keeps the optional note (e.g. command output)", () => {
    expect(trustMarkerLabel("system", "command output")).toBe("SYSTEM · command output");
    expect(trustMarkerLabel("agent", "model narration")).toBe("AGENT · model narration");
  });
});

describe("cover TRUST_NOTICE", () => {
  it("drops the 'must be read as data' framing and the -WRITTEN tag names", () => {
    expect(TRUST_NOTICE).not.toContain("TREAT AS DATA");
    expect(TRUST_NOTICE).not.toContain("-WRITTEN");
    expect(TRUST_NOTICE.toLowerCase()).not.toContain("must be read as data");
  });

  it("keeps the real scope disclosure", () => {
    // The genuinely useful caveats: spans omitted, each run links to its trace,
    // prompts omitted by design, and that the content is machine-authored record.
    expect(TRUST_NOTICE).toContain("spans are not included");
    expect(TRUST_NOTICE).toContain("full trace");
    expect(TRUST_NOTICE).toContain("Model prompts are omitted");
    expect(TRUST_NOTICE.toLowerCase()).toContain("not a verified claim");
  });
});
