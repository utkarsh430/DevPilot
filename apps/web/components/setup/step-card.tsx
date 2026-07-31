// Shared numbered-step card — the "dispatch manifest" row used by the welcome
// onboarding screen and the setup wizard(s). Extracted from
// app/(app)/welcome/page.tsx so both surfaces render steps identically.
//
// Server-safe: no hooks, no browser APIs — usable from server components.

import type { ReactNode } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

export type StepStatus = "todo" | "done" | "attention";

export function StepCard({
  n,
  id,
  title,
  description,
  action,
  children,
  done = false,
  disabled = false,
  status,
  optional = false,
  statusChip,
}: {
  n: number;
  /** Anchor id so failure surfaces can deep-link ("Fix in setup → #github-oauth"). */
  id?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  done?: boolean;
  disabled?: boolean;
  /** Richer tri-state for wizard steps; `done` stays as the boolean shorthand. */
  status?: StepStatus;
  /** Marks a step the platform runs fine without (Langfuse, Stripe). */
  optional?: boolean;
  /** Small trailing chip ("env", "instance default", …) rendered after the title. */
  statusChip?: ReactNode;
}) {
  const resolved: StepStatus = status ?? (done ? "done" : "todo");
  return (
    <Card id={id} className={cn(disabled && "opacity-60", id && "scroll-mt-24")}>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-sm font-semibold",
            resolved === "done" && "border-success/40 bg-success/10 text-success",
            resolved === "attention" && "border-warning/40 bg-warning/10 text-warning",
            resolved === "todo" && "border-border bg-muted text-muted-foreground",
          )}
        >
          {resolved === "done" ? (
            <Check className="h-4 w-4" />
          ) : resolved === "attention" ? (
            <TriangleAlert className="h-3.5 w-3.5" />
          ) : (
            n
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{title}</CardTitle>
            {optional ? <Badge tone="muted">Optional</Badge> : null}
            {statusChip}
          </div>
          {description ? <CardDescription className="mt-1">{description}</CardDescription> : null}
        </div>
      </CardHeader>
      {action || children ? (
        <CardContent>
          {action}
          {children}
        </CardContent>
      ) : null}
    </Card>
  );
}
