// The scan result, rendered.
//
// PRESENTATIONAL ONLY — no hooks, no Radix primitive, no browser API, no server
// action. That is what lets `lib/marketplace/__tests__/skill-scan-render.test.ts`
// render it with `renderToStaticMarkup` under the repo's node-environment
// Vitest, which in turn is what makes the wording claims below testable rather
// than merely intended. The stateful half is `skill-scan.tsx`.
//
// ── The wording is the feature ─────────────────────────────────────────────
//
// Every string that could be read as a verdict comes from `describeScanOutcome`
// in `lib/marketplace/skill-scan.ts`, not from this file, so it is pinned by a
// test and cannot drift into reassurance during a styling change. In particular
// there is NO green tick, NO "clean", NO "safe" and NO score anywhere here —
// see that function's header for why, and note that the limitation sentence is
// rendered in EVERY case including the empty one.
//
// Findings are quoted VERBATIM because the quote is the thing the operator
// actually judges; the category and the one-line reason are our reading of it,
// and are labelled as such. A `negated` finding is shown, not hidden, with its
// heuristic nature stated inline — `detectNegation` is shallow enough that
// hiding on its say-so would be unsafe.

import * as React from "react";
import { AlertTriangle, FileSearch, Info, ShieldQuestion } from "lucide-react";
import type { ScanFinding, SkillScanReport } from "@/lib/marketplace/skill-scan";
import { describeScanOutcome } from "@/lib/marketplace/skill-scan";

export function SkillScanReportPanel({ report }: { report: SkillScanReport }) {
  const outcome = describeScanOutcome(report);
  const has = report.findings.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        className={
          has
            ? "border-warning/30 bg-warning/10 min-w-0 rounded-lg border p-3"
            : "border-border bg-muted/30 min-w-0 rounded-lg border p-3"
        }
      >
        <p className="text-foreground flex items-center gap-1.5 text-sm font-semibold">
          {has ? (
            <AlertTriangle className="text-warning h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <FileSearch className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
          )}
          <span className="min-w-0">{outcome.headline}</span>
        </p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{outcome.detail}</p>
      </div>

      {report.findings.map((f, i) => (
        <FindingRow key={`${f.category}-${i}`} finding={f} />
      ))}

      {/* Always rendered — a finding list invites being read as exhaustive just
          as an empty one invites being read as a pass. */}
      <p className="text-muted-foreground border-border flex gap-2 rounded-lg border border-dashed p-3 text-[11px] leading-relaxed">
        <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">{outcome.limitation}</span>
      </p>
    </div>
  );
}

function FindingRow({ finding }: { finding: ScanFinding }) {
  return (
    <div className="border-border min-w-0 rounded-lg border p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-foreground min-w-0 text-xs font-semibold">{finding.label}</span>
        {typeof finding.line === "number" && (
          <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
            line {finding.line}
          </span>
        )}
        {finding.source === "review" && (
          <span className="border-border text-muted-foreground shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
            model review
          </span>
        )}
      </div>

      <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">{finding.why}</p>

      <pre className="bg-muted/40 text-foreground mt-2 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 font-mono text-[11px] leading-relaxed">
        {finding.evidence}
      </pre>

      {finding.negated && (
        <p className="text-muted-foreground mt-2 flex gap-1.5 text-[11px] leading-relaxed">
          <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0">
            A word like &ldquo;never&rdquo; or &ldquo;do not&rdquo; appears just before this, so it
            may be warning against the thing rather than asking for it. That guess is made from one
            clause of surrounding text and is easy to fool &mdash; read the quoted line.
          </span>
        </p>
      )}
    </div>
  );
}
