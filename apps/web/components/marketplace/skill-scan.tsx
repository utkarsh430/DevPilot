"use client";

// The stateful half of the pre-install scan: a button, a pending state, and the
// report. Every rule and every operator-facing sentence about what the scan
// means lives in `lib/marketplace/skill-scan.ts` and is rendered by
// `skill-scan-report.tsx`; this file holds only the interaction.
//
// The scan is a DELIBERATE PRESS, not something that fires when the review
// dialog opens. Two reasons and both matter: the model pass costs a real LLM
// call on the operator's own subscription, and an automatic verdict appearing
// beside every skill is exactly how a scan stops being read. He opens the body,
// reads it, and asks for a second opinion if he wants one.

import * as React from "react";
import { ScanSearch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { scanSkillAction, type SkillScanActionResult } from "@/lib/marketplace/scan-actions";
import { SkillScanReportPanel } from "@/components/marketplace/skill-scan-report";

export function SkillScan({ skillId }: { skillId: string }) {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<SkillScanActionResult | null>(null);

  async function run() {
    setPending(true);
    try {
      setResult(await scanSkillAction(skillId));
    } catch {
      setResult({ ok: false, error: "The scan could not be run. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="min-w-0">
      <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-tight">
          <ScanSearch className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">Scan the body</span>
        </h3>
        <Button variant="outline" size="sm" onClick={run} disabled={pending} className="gap-1.5">
          {pending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Scanning…
            </>
          ) : (
            <>{result ? "Scan again" : "Run scan"}</>
          )}
        </Button>
      </div>

      {!result && !pending && (
        <p className="text-muted-foreground border-border rounded-lg border border-dashed p-3 text-[11px] leading-relaxed">
          Checks the body for phrasings that would change what an agent does — naming a board tool,
          claiming authority over the prompt above it, routing a secret into a comment, instructing
          something irreversible, or stepping past a review. Then asks a model to read it for
          anything the patterns miss. It reports what it finds; it does not decide whether the skill
          is safe.
        </p>
      )}

      {result && !result.ok && (
        <p className="border-destructive/30 bg-destructive/10 text-foreground rounded-lg border p-3 text-xs">
          {result.error}
        </p>
      )}

      {result && result.ok && <SkillScanReportPanel report={result.report} />}
    </section>
  );
}
