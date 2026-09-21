// The gate that makes the figure design hold.
//
// `freshness.test.ts` proves the fingerprint MATHS is right using synthetic
// inputs. This file points those same functions at the REAL committed figures,
// which is the only place a rotting screenshot can actually be caught. A guide
// whose pictures no longer match the product is worse than one with no
// pictures: the reader came here BECAUSE they were confused, and the fix is now
// confusing them too.
//
// Nothing here looks at PIXELS, and that limit is stated rather than implied -
// see the provenance block below. Every check is about metadata being
// well-formed, internally consistent, and consistent with the repo.

import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GUIDE_FIGURES, GUIDE_FIGURE_CAPTURE, GUIDE_DEFAULT_VIEWPORT } from "../figures";
import { GUIDE_SECTIONS, guideSectionFigureRefs } from "../manifest";
import {
  GUIDE_MAX_FIGURES,
  GUIDE_MAX_FIGURE_BYTES,
  GUIDE_MAX_FIGURES_TOTAL_BYTES,
  GUIDE_FIGURE_THEME,
  checkFigureFreshness,
  checkFigureProvenance,
  fingerprintWatchedFiles,
} from "../freshness";
import { GUIDE_FIXTURE_TENANT_ID, GUIDE_FIXTURE_RUN_ID } from "../fixture";
import provenance from "../capture-provenance.json";

const WEB = join(__dirname, "../../..");
const IMAGES = join(WEB, "public/guide");
const SEED = join(WEB, "../../supabase/seeds/guide-fixture.sql");

const PROVENANCE_BY_ID = new Map(provenance.figures.map((p) => [p.id, p]));

/** Read a figure's watched files exactly as the capture script does. */
function liveFingerprint(watch: readonly string[]): string {
  return fingerprintWatchedFiles(
    watch.map((path) => ({ path, contents: readFileSync(join(WEB, path), "utf8") })),
  );
}

describe("figure declarations", () => {
  it("stays inside the figure-count budget", () => {
    expect(GUIDE_FIGURES.length).toBeLessThanOrEqual(GUIDE_MAX_FIGURES);
  });

  it("has a unique id per figure and a unique file per figure", () => {
    const ids = GUIDE_FIGURES.map((f) => f.id);
    const files = GUIDE_FIGURES.map((f) => f.file);
    expect(new Set(ids).size).toBe(ids.length);
    // Two figures sharing one PNG would make a recapture of either silently
    // rewrite the other, which is invisible in a diff of this file.
    expect(new Set(files).size).toBe(files.length);
  });

  it.each(GUIDE_FIGURES.map((f) => [f.id, f] as const))(
    "%s: alt and caption both say something, and say different things",
    (_id, figure) => {
      expect(figure.alt.trim()).not.toBe("");
      expect(figure.caption.trim()).not.toBe("");
      // A caption duplicating the alt text tells a sighted reader nothing new
      // and reads the same sentence twice to a screen-reader user.
      expect(figure.alt.trim()).not.toBe(figure.caption.trim());
    },
  );
});

describe("figure references", () => {
  const referenced = new Set(GUIDE_SECTIONS.flatMap((s) => guideSectionFigureRefs(s)));
  const declared = new Set(GUIDE_FIGURES.map((f) => f.id));

  it("has no dangling reference - every `figure:` in the prose is declared", () => {
    expect([...referenced].filter((id) => !declared.has(id))).toEqual([]);
  });

  it("has no orphan - every declared figure is actually shown to a reader", () => {
    // An orphan is a committed, byte-carrying PNG that no reader will ever see,
    // and nothing else in the repo would ever surface it.
    expect([...declared].filter((id) => !referenced.has(id))).toEqual([]);
  });
});

describe("committed image files", () => {
  it.each(GUIDE_FIGURES.map((f) => [f.id, f] as const))(
    "%s: exists, is a real PNG or JPEG, and fits the per-figure budget",
    (_id, figure) => {
      const path = join(IMAGES, figure.file);
      const bytes = statSync(path).size;
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(GUIDE_MAX_FIGURE_BYTES);

      // Sniffed by MAGIC BYTES, never by extension. The extension is a claim by
      // whoever named the file; the bytes are the fact. This matters because a
      // webp does not throw in react-pdf - it logs and renders the page with the
      // image silently missing, under a caption still pointing at it.
      const head = readFileSync(path).subarray(0, 8);
      const png = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      expect(png || jpeg).toBe(true);
    },
  );

  it("fits the total byte budget across every figure", () => {
    const total = GUIDE_FIGURES.reduce((n, f) => n + statSync(join(IMAGES, f.file)).size, 0);
    expect(total).toBeLessThanOrEqual(GUIDE_MAX_FIGURES_TOTAL_BYTES);
  });
});

describe("provenance", () => {
  // WHAT THIS CANNOT DO: it verifies that a CLAIM is well-formed and internally
  // consistent. It cannot verify that a capture happened, and it never looks at
  // a pixel - `GUIDE_PROVENANCE_UNPROVEN_EXAMPLE` in `freshness.ts` is a
  // hand-authored entry asserted to PASS. Only review of the committed PNG can
  // establish that the picture shows what the caption says.

  it("records every declared figure", () => {
    expect([...PROVENANCE_BY_ID.keys()].sort()).toEqual(GUIDE_FIGURES.map((f) => f.id).sort());
  });

  it.each(GUIDE_FIGURES.map((f) => [f.id, f] as const))(
    "%s: was captured locally, in the one theme, at a real commit",
    (id, figure) => {
      const record = PROVENANCE_BY_ID.get(id);
      expect(record, `no provenance record for ${id}`).toBeDefined();

      const verdict = checkFigureProvenance({
        capturedAt: record!.capturedAt,
        theme: record!.theme,
        build: record!.build,
        host: record!.host,
      });
      expect(verdict, `provenance for ${id}`).toEqual({ ok: true });

      // The two keys the capture script enforces, re-asserted from the record.
      // Enforcement evaporates when the run ends; the record is what survives.
      expect(record!.fixtureTenantId).toBe(GUIDE_FIXTURE_TENANT_ID);
      expect(figure.theme).toBe(GUIDE_FIGURE_THEME);

      // Ties the committed bytes to the run that claims to have produced them.
      // A hand-replaced or re-optimised PNG no longer matches, and should not:
      // the provenance would be describing an image that no longer exists.
      expect(statSync(join(IMAGES, figure.file)).size).toBe(record!.bytes);
    },
  );

  it("refuses a non-local capture host", () => {
    // The control. Without this the provenance assertions above would pass just
    // as happily against a check that returned `{ok:true}` unconditionally.
    expect(
      checkFigureProvenance({
        capturedAt: "2026-07-20T09:15:00.000Z",
        theme: GUIDE_FIGURE_THEME,
        build: "a1b2c3d",
        host: "https://abcdefgh.supabase.co",
      }),
    ).toEqual({ ok: false, reason: 'capture host must be local, got "abcdefgh.supabase.co"' });
  });
});

describe("freshness", () => {
  it.each(GUIDE_FIGURES.map((f) => [f.id, f] as const))(
    "%s: the files that compose this screen have not moved since it was captured",
    (id, figure) => {
      const verdict = checkFigureFreshness(figure, liveFingerprint(figure.watch));
      if (verdict.state === "stale") {
        throw new Error(
          `Figure "${id}" is out of date: ${figure.watch.join(", ")} changed since it was ` +
            `captured.\n\nEither recapture:\n    pnpm --filter @devpilot/web capture:guide\n\n` +
            `or, if the change cannot affect this figure, acknowledge it explicitly by adding ` +
            `to the figure:\n\n    staleAcknowledged: {\n      fingerprint: "${verdict.actual}",\n` +
            `      note: "<why this is acceptable, in your own words - the reader sees this>",\n` +
            `      since: "<YYYY-MM-DD>",\n    }\n`,
        );
      }
      if (verdict.state === "acknowledgement-expired") {
        throw new Error(
          `Figure "${id}" carries a stale acknowledgement that no longer applies: it excuses ` +
            `${verdict.acknowledged}, but the watched files are now ${verdict.actual}. That is ` +
            `the acknowledgement working as designed - it pins one fingerprint rather than ` +
            `excusing every future drift. Recapture, or re-acknowledge the new fingerprint.`,
        );
      }
      expect(["fresh", "acknowledged"]).toContain(verdict.state);
    },
  );

  it("declares 2-4 composing files per figure, not a directory tree", () => {
    for (const figure of GUIDE_FIGURES) {
      expect(figure.watch.length).toBeGreaterThanOrEqual(2);
      // A broad watch goes red on every unrelated edit, and a gate people resent
      // is a gate that gets deleted rather than fixed.
      expect(figure.watch.length).toBeLessThanOrEqual(4);
      for (const path of figure.watch) expect(path).not.toContain("*");
    }
  });

  it("goes RED on a real drift, and GREEN under a matching acknowledgement", () => {
    // Driven off a REAL figure with its REAL watched files, so this exercises
    // the same path the per-figure assertions above take. The drift is simulated
    // by handing the checker a fingerprint the figure does not carry.
    // Any acknowledgement the real figure happens to carry is stripped: this
    // test is about the mechanism, and inheriting one turns the first assertion
    // into `acknowledgement-expired`, which is a different (correct) verdict
    // about a different question.
    const sample = GUIDE_FIGURES[0];
    if (!sample) throw new Error("GUIDE_FIGURES is empty - nothing to check freshness against");
    const { staleAcknowledged: _ignored, ...figure } = sample;
    const drifted = liveFingerprint([...figure.watch, "lib/guide/freshness.ts"]);
    expect(drifted).not.toBe(figure.fingerprint);

    expect(checkFigureFreshness(figure, drifted).state).toBe("stale");

    const acknowledged = {
      ...figure,
      staleAcknowledged: { fingerprint: drifted, note: "n/a", since: "2026-07-20" },
    };
    expect(checkFigureFreshness(acknowledged, drifted).state).toBe("acknowledged");

    // And the pin is a pin: further drift on the same files goes red again,
    // which is the entire reason the escape hatch is safe to offer.
    const driftedAgain = liveFingerprint([...figure.watch, "lib/guide/blocks.ts"]);
    expect(checkFigureFreshness(acknowledged, driftedAgain).state).toBe("acknowledgement-expired");
  });
});

describe("capture specs", () => {
  it("pairs one-to-one with the declared figures", () => {
    expect(GUIDE_FIGURE_CAPTURE.map((s) => s.id).sort()).toEqual(
      GUIDE_FIGURES.map((f) => f.id).sort(),
    );
  });

  it("records the crop it captured as the figure's intrinsic size", () => {
    // The web `<img>` reserves layout from `width`/`height`; if they disagree
    // with the crop the page reflows when the image lands.
    for (const spec of GUIDE_FIGURE_CAPTURE) {
      const figure = GUIDE_FIGURES.find((f) => f.id === spec.id)!;
      expect([figure.width, figure.height]).toEqual([spec.crop.width, spec.crop.height]);
    }
  });

  it("keeps every crop inside its own viewport", () => {
    // A crop running past the viewport is silently clipped by the browser, and
    // the result looks like a rendering bug in the product rather than a
    // mis-specified rectangle here.
    for (const spec of GUIDE_FIGURE_CAPTURE) {
      const vp = { ...GUIDE_DEFAULT_VIEWPORT, ...(spec.viewport ?? {}) };
      expect(spec.crop.x + spec.crop.width).toBeLessThanOrEqual(vp.width);
      expect(spec.crop.y + spec.crop.height).toBeLessThanOrEqual(vp.height);
    }
  });

  it("never writes a fixture id by hand", () => {
    // The uuids live in `fixture.ts` and nowhere else. A second copy here drifts
    // from the seed and fails as a 404 in the middle of a capture run.
    const source = readFileSync(join(WEB, "lib/guide/figures.ts"), "utf8");
    const specSource = source.slice(source.indexOf("GUIDE_FIGURE_CAPTURE"));
    expect(specSource).not.toContain(GUIDE_FIXTURE_RUN_ID);
    expect(GUIDE_FIGURE_CAPTURE.some((s) => s.path.includes(GUIDE_FIXTURE_RUN_ID))).toBe(true);
  });
});

describe("the fixture seed", () => {
  const sql = readFileSync(SEED, "utf8");

  it("uses the same ids the app-side constants declare", () => {
    // Two hand-maintained copies of a uuid is precisely the drift that produces
    // an empty board and a capture failure nobody can explain.
    expect(sql).toContain(GUIDE_FIXTURE_TENANT_ID);
    expect(sql).toContain(GUIDE_FIXTURE_RUN_ID);
  });

  it("carries no psql meta-commands", () => {
    // The capture script applies this through node-postgres, which speaks the
    // wire protocol and does not implement `\\set`. A meta-command here is a
    // syntax error at exactly the moment the script needs to work.
    expect(sql).not.toMatch(/^\\/m);
  });

  it("expresses every timestamp as an offset from now(), never a fixed instant", () => {
    // Fixed instants age: a row stamped 2026-05-04 renders as "3d ago" this week
    // and "2mo ago" next month, so an unchanged UI yields a different PNG on
    // every recapture. `relativeTime` is called during SERVER render under
    // `suppressHydrationWarning`, so a frozen browser clock cannot fix this -
    // only the data can.
    const timestampLiteral = /'\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
    expect(sql).not.toMatch(timestampLiteral);
    expect(sql).toContain("now() - interval");
  });
});
