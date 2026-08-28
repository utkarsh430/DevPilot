// How an installed copy stands relative to the catalogue, rendered.
//
// Its own component, and deliberately free of any Radix primitive or browser
// API, so the rule it carries can be proven by RENDERING it under the repo's
// node-environment Vitest rather than only by unit-testing the predicate behind
// it — the same reason `skill-edit-link.tsx` is split out. The confirmation
// dialog for the reset control stays in `catalog.tsx` for exactly that reason.
//
// The one rule worth stating here: an EDITED copy is not a warning. Adapting an
// installed skill to your own stack is the supported workflow, and the card used
// to flag it amber forever — which is how an operator learns to ignore the flag
// that would have told him the catalogue itself had changed. `needsAttention`
// draws that line and `describeSkillProvenance` owns it.

import * as React from "react";
import { GitCompare, PenLine, Check, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { describeSkillProvenance, type SkillProvenance } from "@/lib/marketplace/skill-provenance";

export function SkillProvenanceBadge({ provenance }: { provenance: SkillProvenance }) {
  const copy = describeSkillProvenance(provenance);
  return (
    <Badge tone={copy.tone} className="shrink-0 text-[10px]">
      {provenance.kind === "authored" && <PenLine aria-hidden />}
      {provenance.kind === "pristine" && <Check aria-hidden />}
      {provenance.kind === "edited" && <Sparkles aria-hidden />}
      {copy.needsAttention && <GitCompare aria-hidden />}
      {copy.label}
    </Badge>
  );
}

/**
 * The one-sentence explanation.
 *
 * Rendered as visible text rather than a tooltip, on the same reasoning the
 * landing-state chip uses: "differs from the catalogue" with no reason is what
 * sends an operator digging, and a reason he has to hover to find is a reason
 * most people never read.
 */
export function SkillProvenanceNote({ provenance }: { provenance: SkillProvenance }) {
  const copy = describeSkillProvenance(provenance);
  // The boring cases say nothing. A note on every card is a note nobody reads.
  if (provenance.kind === "pristine" || provenance.kind === "authored") return null;
  return (
    <p
      className={
        copy.needsAttention
          ? "text-warning mt-2 text-[10px] font-medium"
          : "text-muted-foreground mt-2 text-[10px]"
      }
    >
      {copy.detail}
    </p>
  );
}
