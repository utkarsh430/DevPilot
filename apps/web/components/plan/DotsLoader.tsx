"use client";

// Three pulsing dots used by the build-mode StagePill and the new pending
// assistant bubble. Extracted from PlanSheet.tsx so both consumers can import
// it without dragging the rest of the Sheet through their bundle.

export function DotsLoader() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      <span
        className="h-1 w-1 animate-pulse rounded-full bg-current"
        style={{ animationDelay: "0ms", animationDuration: "1000ms" }}
      />
      <span
        className="h-1 w-1 animate-pulse rounded-full bg-current"
        style={{ animationDelay: "200ms", animationDuration: "1000ms" }}
      />
      <span
        className="h-1 w-1 animate-pulse rounded-full bg-current"
        style={{ animationDelay: "400ms", animationDuration: "1000ms" }}
      />
    </span>
  );
}
