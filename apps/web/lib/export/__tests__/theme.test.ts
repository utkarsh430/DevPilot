// Drift guard: the export's frozen palette vs the live `app/globals.css`.
//
// `theme.ts` hard-codes the light-mode tokens as HSL triples because react-pdf
// has no CSS variables. That copy is the problem this test exists for: restyling
// the app is supposed to restyle the export, and without a check the export
// would keep printing last season's brand in silence — the kind of bug nobody
// files because the PDF still "looks fine".
//
// It parses the REAL stylesheet rather than a fixture, so the two cannot drift.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLORS, TOKENS_HSL, hslToHex, mix, roleColor, roleFamily } from "@/lib/export/theme";

const CSS = readFileSync(
  fileURLToPath(new URL("../../../app/globals.css", import.meta.url)),
  "utf8",
);

/** Read a custom property out of the `:root` block (DevPilot Light). */
function rootToken(name: string): string {
  // `:root { … }` is the first block; stop at the first closing brace so a later
  // theme's redefinition of the same token can never be picked up by accident.
  const root = /:root\s*\{([\s\S]*?)\}/.exec(CSS)?.[1];
  if (!root) throw new Error("globals.css must contain a :root block");
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(root)?.[1];
  if (!value) throw new Error(`globals.css :root must declare --${name}`);
  return value.trim();
}

function parseHsl(v: string): [number, number, number] {
  const m = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(v);
  if (!m) throw new Error(`expected an "H S% L%" triple, got ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe("theme drift vs app/globals.css", () => {
  // The role spectrum is the load-bearing set: AGENTS.md pins chart-1..5 to
  // blue PM / green QA / amber DevOps / violet Engineer / red Security, and the
  // export colours every agent chip and rollup bar from it.
  const TOKENS: Array<[keyof typeof TOKENS_HSL, string]> = [
    ["primary", "primary"],
    ["chart1", "chart-1"],
    ["chart2", "chart-2"],
    ["chart3", "chart-3"],
    ["chart4", "chart-4"],
    ["chart5", "chart-5"],
    ["background", "background"],
    ["foreground", "foreground"],
    ["card", "card"],
    ["muted", "muted"],
    ["mutedForeground", "muted-foreground"],
    ["border", "border"],
    ["destructive", "destructive"],
    ["success", "success"],
    ["warning", "warning"],
    ["accent", "accent"],
  ];

  it.each(TOKENS)("--%s matches the frozen value", (key, cssName) => {
    expect(parseHsl(rootToken(cssName))).toEqual([...TOKENS_HSL[key]]);
  });
});

describe("hslToHex", () => {
  it("converts the known anchors", () => {
    expect(hslToHex([0, 0, 100])).toBe("#ffffff");
    expect(hslToHex([0, 0, 0])).toBe("#000000");
    expect(hslToHex([0, 100, 50])).toBe("#ff0000");
    expect(hslToHex([120, 100, 50])).toBe("#00ff00");
    expect(hslToHex([240, 100, 50])).toBe("#0000ff");
  });

  it("produces a 6-digit hex for every token", () => {
    for (const [name, hex] of Object.entries(COLORS)) {
      expect(hex, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("mix — precomputed tints", () => {
  it("returns the endpoints at alpha 0 and 1", () => {
    expect(mix("#ff0000", "#ffffff", 1)).toBe("#ff0000");
    expect(mix("#ff0000", "#ffffff", 0)).toBe("#ffffff");
  });

  it("composites toward the backdrop", () => {
    // react-pdf has no alpha-over-parent compositing, so every tint is mixed at
    // author time. A 50% red on white is the classic pink.
    expect(mix("#ff0000", "#ffffff", 0.5)).toBe("#ff8080");
  });

  it("clamps out-of-range alpha rather than producing garbage", () => {
    expect(mix("#ff0000", "#ffffff", 5)).toBe("#ff0000");
    expect(mix("#ff0000", "#ffffff", -5)).toBe("#ffffff");
  });
});

describe("roleColor", () => {
  it("maps each role family to its spectrum colour", () => {
    expect(roleColor("pm")).toBe(COLORS.chart1);
    expect(roleColor("qa")).toBe(COLORS.chart2);
    expect(roleColor("devops")).toBe(COLORS.chart3);
    expect(roleColor("engineer")).toBe(COLORS.chart4);
    expect(roleColor("security")).toBe(COLORS.chart5);
  });

  it("places related roles in the same family", () => {
    expect(roleFamily("backend_engineer")).toBe("engineering");
    expect(roleFamily("sdet")).toBe("qa");
    expect(roleFamily("sre")).toBe("devops");
    expect(roleFamily("appsec_engineer")).toBe("security");
    expect(roleFamily("product_manager")).toBe("product");
  });

  it("falls back to muted for an unknown or absent role, never a borrowed colour", () => {
    // Custom JD-synthesized roles have arbitrary slugs. Giving one a family's
    // colour would imply a membership it does not have.
    expect(roleColor("loc_reviewer")).toBe(COLORS.mutedForeground);
    expect(roleColor(null)).toBe(COLORS.mutedForeground);
    expect(roleColor(undefined)).toBe(COLORS.mutedForeground);
    expect(roleFamily("totally_made_up")).toBe("other");
  });
});
