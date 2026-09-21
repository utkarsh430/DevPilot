// The manual's content hash — the ETag the route caches on.
//
// This value decides whether a reader gets a freshly rendered manual or a
// previously cached one, so the failure it must not have is TWO DIFFERENT
// MANIFESTS HASHING THE SAME. That reader would be served a PDF of content that
// no longer exists, with a 200 and a matching validator, and nothing anywhere
// would look wrong.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { guideContentHash, guideContentVersion } from "@/lib/guide/manual-version";

describe("the hash is a usable validator", () => {
  it("is a stable sha256 hex digest", () => {
    const a = guideContentHash();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic across calls — it reads only static constants. A hash that
    // moved per call would make every request a cache miss AND every 304 a lie.
    expect(guideContentHash()).toBe(a);
  });

  it("the cover version is a prefix of it", () => {
    // The cover prints a short form; a reader comparing it against an ETag in a
    // support conversation must be looking at the same value.
    expect(guideContentHash().startsWith(guideContentVersion())).toBe(true);
    expect(guideContentVersion()).toHaveLength(12);
  });
});

describe("adjacent fields cannot be shuffled between each other", () => {
  // The property the U+001F separator buys, tested directly on the technique
  // rather than through the module — the real manifest cannot be mutated from
  // here, and the bug is in the JOIN, not in which constants are read.
  //
  // A space-joined digest cannot tell `{title: "a b", summary: "c"}` from
  // `{title: "a", summary: "b c"}`, and both are entirely ordinary content. This
  // asserts the separator actually distinguishes them.
  function digest(fields: string[], sep: string): string {
    return createHash("sha256").update(fields.join(sep)).digest("hex");
  }

  /** The same U+001F `SEP` the module joins with, written as an escape. */
  const UNIT_SEPARATOR = "\u001f";

  const shifted = ["a b", "c"];
  const original = ["a", "b c"];

  it("a space separator collides on ordinary content — the bug being avoided", () => {
    // Non-vacuity: this is what makes the assertion below meaningful rather
    // than a tautology about two different strings hashing differently.
    expect(digest(shifted, " ")).toBe(digest(original, " "));
  });

  it("the unit separator does not", () => {
    expect(digest(shifted, UNIT_SEPARATOR)).not.toBe(digest(original, UNIT_SEPARATOR));
  });
});
