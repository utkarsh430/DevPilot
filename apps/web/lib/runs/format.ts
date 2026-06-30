// Shared presentation helpers for the Run Inspector surface.
//
// `fmtDuration` and `fmtCents` were previously copy-pasted across StepTree,
// RunInspector, and StepDetail with subtly different null-handling. The
// waterfall view needs the same formatting, so the canonical versions live
// here and every runs/trace component imports them.

/** Human-readable wall-clock duration: `840ms`, `4.2s`, `1m03s`. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

/** Spend in cents rendered as `$0`, `42¢`, or `$1.37`. Tolerates null/undefined. */
export function fmtCents(c: number | null | undefined): string {
  if (!c || c <= 0) return "$0";
  if (c < 100) return `${c}¢`;
  return `$${(c / 100).toFixed(2)}`;
}
