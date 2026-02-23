import * as React from "react";
import { cn } from "@/lib/cn";

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "border-border bg-muted text-muted-foreground inline-flex h-5 select-none items-center gap-0.5 rounded border px-1.5 font-mono text-[10px] font-medium",
        className,
      )}
      {...props}
    />
  );
}
