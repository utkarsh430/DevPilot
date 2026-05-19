// Static handoff diagram framing the core PM → Engineer → QA → Security loop.
// Presentational only — it exists to explain *why* DevPilot is a team of roles,
// not a flat list. Kept deliberately simple (no React Flow, no interactivity).
// Shared by the Agents page ("How the team works") and welcome onboarding
// ("Meet your crew") — one owner, two framings via the title/description props.

import { ArrowRight, ClipboardList, Code2, CheckCircle2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";

const STEPS = [
  { label: "PM", blurb: "Refines the ticket", Icon: ClipboardList, accent: "text-chart-1" },
  { label: "Engineer", blurb: "Implements the change", Icon: Code2, accent: "text-chart-2" },
  { label: "QA", blurb: "Reviews & tests", Icon: CheckCircle2, accent: "text-chart-3" },
  { label: "Security", blurb: "Audits the diff", Icon: ShieldCheck, accent: "text-chart-5" },
] as const;

export function HandoffDiagram({
  title = "How the team works",
  description = "Roles pass work as tickets on the board. The canonical loop hands a ticket from role to role — specialists below slot into the same flow.",
  className,
}: {
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <section
      aria-label="Core role handoff"
      className={cn("bg-card rounded-lg border p-5", className)}
    >
      <div className="mb-4 flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <ol className="flex flex-wrap items-stretch gap-2">
        {STEPS.map((step, i) => (
          <li key={step.label} className="flex items-center gap-2">
            <div className="bg-background flex min-w-[9rem] flex-col gap-1 rounded-md border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <step.Icon className={`h-4 w-4 ${step.accent}`} aria-hidden />
                <span className="text-sm font-medium leading-none">{step.label}</span>
              </div>
              <span className="text-muted-foreground text-xs">{step.blurb}</span>
            </div>
            {i < STEPS.length - 1 && (
              <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
