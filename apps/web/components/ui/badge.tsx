import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium leading-tight transition-colors [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        default: "border-border bg-secondary text-secondary-foreground",
        outline: "border-border bg-transparent text-foreground",
        // bg-*/5 (not /10) — at 10% tint, full-strength chart-1/chart-4 text
        // dropped below 4.5:1 WCAG AA against the tinted chip background in
        // several themes (as low as 4.35:1); /5 keeps the tint visible while
        // staying comfortably above AA across all 5 themes.
        info: "border-chart-1/30 bg-chart-1/5 text-chart-1",
        warn: "border-warning/30 bg-warning/5 text-warning",
        danger: "border-destructive/30 bg-destructive/5 text-destructive",
        ok: "border-success/30 bg-success/5 text-success",
        violet: "border-chart-4/30 bg-chart-4/5 text-chart-4",
        muted: "border-border bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
