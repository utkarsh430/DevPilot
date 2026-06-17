// The activity surface OBSERVES. It must never dispatch, cancel, retry or
// otherwise mutate a run.
//
// This is a SOURCE SCAN rather than a runtime assertion, and that is the point:
// a runtime test can only prove that the ONE path it exercised performed no
// write. The claim here is about every path in these three files — including
// ones a later edit adds — which is a claim only a scan over the source can
// make. `use-active-runs.ts` and `activity-indicator.tsx` are "use client"
// modules that call `supabaseBrowser()` and import React/Next chrome, so they
// cannot be loaded under this repo's node-environment Vitest at all; that gap
// is exactly where an unnoticed write would live.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..");

/** Every file that makes up this surface. */
const SURFACE_FILES = [
  "lib/activity/active-runs.ts",
  "lib/activity/query.ts",
  "lib/realtime/use-active-runs.ts",
  "components/shell/activity-indicator.tsx",
] as const;

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

/** Strip comments so prose about mutation never trips (or excuses) the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Supabase write verbs. `rpc` is included because a SECURITY DEFINER function
 * is a write path carrying none of the other verbs.
 *
 * `.delete(` is deliberately NOT in this list, and the omission is the reason
 * the next test exists: `Map.prototype.delete` is a legitimate local call (the
 * hook keeps an id→status mirror), so a bare substring scan for it flags real
 * code. Contorting the implementation to satisfy the scan would be the wrong
 * trade — a table-scoped structural check is both stricter AND correct.
 */
const WRITE_CALLS = [".insert(", ".update(", ".upsert(", ".rpc("] as const;

describe("the activity surface issues no mutations", () => {
  it.each(SURFACE_FILES)("%s performs no Supabase write", (rel) => {
    const src = stripComments(read(rel));
    for (const verb of WRITE_CALLS) {
      expect(src, `${rel} must not call ${verb}`).not.toContain(verb);
    }
  });

  it("only the data accessor can reach a table at all", () => {
    // THE STRUCTURAL GUARANTEE, and it is what makes the verb list above a
    // belt rather than the only brace: a Supabase mutation is always rooted at
    // `.from(<table>)`. If the hook and the component cannot name a table,
    // they have no write path regardless of which verbs they contain — which
    // is precisely why `Map.delete` in the hook is harmless.
    for (const rel of SURFACE_FILES) {
      const src = stripComments(read(rel));
      const reachesTable = /\.from\(/.test(src);
      if (rel === "lib/activity/query.ts") {
        expect(reachesTable, "the accessor is the one file that reads").toBe(true);
      } else {
        expect(reachesTable, `${rel} must not reach a table directly`).toBe(false);
      }
    }
  });

  it("the accessor never deletes", () => {
    // Checked HERE rather than in the shared list: query.ts holds no Map or
    // Set, so a bare substring scan for `.delete(` is unambiguous in this one
    // file and stays maximally strict where it can.
    expect(stripComments(read("lib/activity/query.ts"))).not.toContain(".delete(");
  });

  it.each(SURFACE_FILES)("%s imports no server action", (rel) => {
    const src = stripComments(read(rel));
    // Server actions in this repo are named `<verb>Action` and live under
    // `app/**/actions` or `lib/**/actions`. Importing one is the other way a
    // read-only surface acquires a write.
    expect(src, `${rel} must not import an actions module`).not.toMatch(
      /from\s+["'][^"']*\/actions["']/,
    );
    expect(src, `${rel} must not reference a server action`).not.toMatch(/\b[a-zA-Z]+Action\s*\(/);
  });

  it.each(SURFACE_FILES)("%s never writes with the service-role client", (rel) => {
    const src = stripComments(read(rel));
    // This surface is browser-side and RLS-bound. A service-role client here
    // would bypass `runs_member_read`, which is the actual tenant boundary.
    expect(src, `${rel} must not use the service client`).not.toContain("supabaseService");
  });

  it("only ever reads the runs table, via select", () => {
    const src = stripComments(read("lib/activity/query.ts"));
    const tables = [...src.matchAll(/\.from\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(tables).toEqual(["runs"]);
    expect(src).toContain(".select(");
  });

  it("the scan is non-vacuous: it detects a write when one is present", () => {
    // Guards the guard. If `stripComments` or the matching ever broke, every
    // assertion above would pass on any input — this proves it does not.
    const withWrite = stripComments(`
      const x = client.from("runs").update({ status: "cancelled" });
    `);
    expect(WRITE_CALLS.some((verb) => withWrite.includes(verb))).toBe(true);
    // …and that the structural check would have caught it independently.
    expect(/\.from\(/.test(withWrite)).toBe(true);
  });

  it("the structural check does not mistake a local Map for a table", () => {
    // The false positive that motivated splitting the two checks apart. A
    // `Map.delete` must read as harmless; a real table write must not.
    const localOnly = stripComments(`trackedRef.current.delete(row.id);`);
    expect(/\.from\(/.test(localOnly)).toBe(false);
    expect(WRITE_CALLS.some((verb) => localOnly.includes(verb))).toBe(false);
  });

  it("the comment stripper does not blind the scan to real code", () => {
    // A write on a line that merely FOLLOWS a comment must still be seen.
    const src = stripComments(`
      // we never call .update( here
      client.from("runs").update({ a: 1 });
    `);
    expect(src).not.toContain("we never call");
    expect(src).toContain(".update(");
  });
});

describe("surface file list stays honest", () => {
  it("every listed file exists and is non-empty", () => {
    for (const rel of SURFACE_FILES) {
      expect(read(rel).length, `${rel} should exist`).toBeGreaterThan(0);
    }
  });

  it("the indicator is wired into the topbar", () => {
    // If the component were dropped from the chrome the tests above would still
    // pass while the feature did nothing — so pin the wiring too.
    const topbar = stripComments(read("components/shell/topbar.tsx"));
    expect(topbar).toContain("ActivityIndicator");
    expect(topbar).toContain("tenantId={tenantId}");
  });
});
