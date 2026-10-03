// Bounding the Inngest dev-server log. PURE (no IO) so it can be unit-tested;
// the launcher that uses it is `apps/web/scripts/dev-inngest.mjs`.
//
// ── WHY ────────────────────────────────────────────────────────────────────
// On 2026-08-03 the dev server wedged for the third time in two days and
// emitted `could not check constraints to lease item` 4,992,566 times into a
// 29.9 GB log file. On a smaller disk that fills the volume and takes the
// machine down — so the log is a defect in its own right, independent of the
// bug that produced the lines.
//
// Two bounds, and they solve genuinely different problems. Keep both:
//
//   • ROTATION is the actual ceiling. It is what makes the disk cost of ANY
//     future runaway finite, including one that emits a different line every
//     time and so cannot be collapsed at all.
//
//   • REPEAT-COLLAPSING is what keeps the log READABLE, and it is not merely
//     cosmetic here. Five million copies of one sentence is not five million
//     facts; it is one fact plus a number. Rotation alone would have kept the
//     disk safe and still left the operator with a 64 MiB file containing
//     nothing but that sentence, with the useful lines that preceded the wedge
//     already rotated away.
//
// The collapse is deliberately CONSERVATIVE, because a log that silently drops
// lines is worse than a large one:
//   • only CONSECUTIVE identical messages collapse;
//   • the first occurrence is always emitted immediately and in full, so
//     nothing is ever hidden — you always learn WHAT happened, at the moment it
//     first happened;
//   • the repeat count is always reported when the run of duplicates ends, so
//     "this happened five million times" survives, which is the fact that
//     actually diagnoses a wedge;
//   • timestamps and other varying fields make lines non-identical, so a
//     healthy chatty log is untouched.

/** Rotate at 64 MiB. Large enough to hold a real debugging session, small
 *  enough that the file plus its one kept predecessor can never be a disk
 *  problem (128 MiB worst case). Override with DEVPILOT_INNGEST_LOG_MAX_BYTES. */
export const INNGEST_LOG_MAX_BYTES_DEFAULT = 64 * 1024 * 1024;

/** How many rotated generations to keep. One: the current file plus `.1`. The
 *  point is a bound, not an archive — anything worth keeping from a dev server
 *  gets copied out. */
export const INNGEST_LOG_KEEP = 1;

export function shouldRotate(currentBytes: number, maxBytes: number): boolean {
  return Number.isFinite(currentBytes) && Number.isFinite(maxBytes) && currentBytes >= maxBytes;
}

/** Resolve the byte ceiling from an env value, ignoring anything unusable. A
 *  bad value must fall back to the default, never to "unbounded" — that is the
 *  state this module exists to make unreachable. */
export function resolveLogMaxBytes(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : INNGEST_LOG_MAX_BYTES_DEFAULT;
}

/**
 * Strip the parts of a log line that vary between otherwise-identical events,
 * so a repeated error is recognised as repeated.
 *
 * `inngest dev` writes either human lines carrying an RFC3339 timestamp or, with
 * `--json`, one JSON object per line. Both embed a time, and the JSON form also
 * embeds a per-item id. Without this, five million copies of one error look
 * like five million distinct lines and nothing collapses.
 *
 * Conservative by construction: it only blanks things that are unambiguously
 * time- or id-shaped. Two genuinely different errors cannot normalise to the
 * same key unless their entire message text is identical, which is exactly the
 * case we want to collapse.
 */
export function normalizeLogLine(line: string): string {
  return (
    line
      // ISO-8601 / RFC3339 timestamps, with or without fractional seconds.
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
      // Bare clock times (the dev server's default human format).
      .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<ts>")
      // ULIDs / UUIDs / long hex ids that differ per queue item.
      .replace(
        /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
        "<id>",
      )
      .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "<id>")
      .replace(/\b[0-9a-f]{16,}\b/g, "<id>")
      .trim()
  );
}

export type CollapseEmit =
  | { kind: "line"; text: string }
  /** The run of duplicates that just ended. `count` EXCLUDES the first
   *  occurrence, which was already emitted verbatim. */
  | { kind: "repeat"; count: number; sample: string };

/**
 * Fold consecutive duplicate lines into one line plus a count.
 *
 * Usage is a stream: feed every line to `push`, write whatever it returns, and
 * call `flush` at end-of-stream so a run still in progress is not lost.
 */
export class RepeatCollapser {
  private lastKey: string | null = null;
  private lastLine = "";
  private repeats = 0;

  /** Below this, printing the duplicates costs less than the summary line. */
  constructor(private readonly threshold = 1) {}

  push(line: string): CollapseEmit[] {
    const key = normalizeLogLine(line);
    // Blank lines are structure, not content — never collapse them.
    if (key.length === 0) {
      const out = this.flush();
      out.push({ kind: "line", text: line });
      this.lastKey = null;
      return out;
    }
    if (key === this.lastKey) {
      this.repeats += 1;
      return [];
    }
    const out = this.flush();
    this.lastKey = key;
    this.lastLine = line;
    out.push({ kind: "line", text: line });
    return out;
  }

  /** Emit the pending repeat summary, if any. Safe to call repeatedly. */
  flush(): CollapseEmit[] {
    if (this.repeats < this.threshold) {
      this.repeats = 0;
      return [];
    }
    const out: CollapseEmit[] = [{ kind: "repeat", count: this.repeats, sample: this.lastLine }];
    this.repeats = 0;
    return out;
  }
}

/** Render a collapsed run for the log. States the count plainly — that number
 *  IS the diagnosis when a dev server is wedged in a retry loop. */
export function renderRepeat(count: number): string {
  return `    … last line repeated ${count.toLocaleString("en-US")} more time${count === 1 ? "" : "s"}`;
}
