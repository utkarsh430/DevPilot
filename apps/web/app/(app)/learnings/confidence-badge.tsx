// One confidence chip, shared by BOTH lesson views (the card review stack and
// the table) so the two can never disagree about what a grade looks like.
//
// `confidence` is NULLABLE — the lesson-confidence grader stamps it asynchronously, so a
// freshly-extracted lesson (and every lesson predating the grader) arrives with
// null. That renders as a muted "ungraded" chip, never as a grade: an ungraded
// lesson is one nobody has vouched for, and showing it as anything else would
// invite exactly the sweeping approval the confidence system exists to prevent.

import { Badge } from "@/components/ui/badge";
import { ShieldCheck, ShieldQuestion, ShieldAlert, CircleDashed } from "lucide-react";
import type { LessonConfidence } from "@/lib/learning/table-view";

const META: Record<
  LessonConfidence,
  { label: string; tone: "ok" | "warn" | "danger"; Icon: typeof ShieldCheck; hint: string }
> = {
  high: {
    label: "High",
    tone: "ok",
    Icon: ShieldCheck,
    hint: "Safe to apply to every future run.",
  },
  medium: {
    label: "Medium",
    tone: "warn",
    Icon: ShieldQuestion,
    hint: "Sound but situational — worth a glance.",
  },
  low: {
    label: "Low",
    tone: "danger",
    Icon: ShieldAlert,
    hint: "Vague, sweeping, risky or conflicting — needs your call.",
  },
};

export const CONFIDENCE_HINT: Record<LessonConfidence, string> = {
  high: META.high.hint,
  medium: META.medium.hint,
  low: META.low.hint,
};

export function ConfidenceBadge({
  confidence,
  className,
}: {
  confidence: LessonConfidence | null;
  className?: string;
}) {
  if (!confidence) {
    return (
      <Badge tone="muted" className={className} title="Not graded yet.">
        <CircleDashed aria-hidden />
        Ungraded
      </Badge>
    );
  }
  const { label, tone, Icon, hint } = META[confidence];
  return (
    <Badge tone={tone} className={className} title={hint}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}

/** The grader's one-line justification, shown under the badge in both views.
 *  Model-authored text — rendered as plain text (React escapes it). */
export function ConfidenceReason({ reason }: { reason: string | null }) {
  if (!reason || reason.trim().length === 0) return null;
  return <p className="text-muted-foreground text-xs leading-relaxed">{reason.trim()}</p>;
}
