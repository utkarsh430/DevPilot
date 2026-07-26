// Phase 2.5++ / C4 — Shared slugify helper for the web app.
//
// Centralized so the web side doesn't duplicate the rule. The runner package
// (`apps/runner/src/workspace.ts`) keeps its own copy because the two
// packages don't share a tsconfig at runtime; the regex semantics MUST stay
// in sync (lower-case, `[^a-z0-9]+` → `-`, trim hyphens, length cap,
// fallback "ticket").

const DEFAULT_MAX_LEN = 60;

export function slugify(s: string, opts?: { maxLen?: number }): string {
  const maxLen = opts?.maxLen ?? DEFAULT_MAX_LEN;
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLen) || "ticket"
  );
}
