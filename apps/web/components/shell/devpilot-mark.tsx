import { cn } from "@/lib/cn";

/**
 * DevPilot brand mark — "the handoff". Three kanban lanes draining left to
 * right, with one card in flight toward Done. The lanes inherit
 * `currentColor`; the card is always the signal accent (`--primary`), which
 * is the brand's one bright color in both light and dark chrome.
 *
 * Reads at 14px (three descending bars) and gains the card detail from
 * ~20px up. Place it directly on the surface — it needs no tile behind it.
 */
export function DevPilotMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={cn("h-4 w-4", className)}
    >
      <rect x="3" y="3" width="4.2" height="18" rx="2.1" fill="currentColor" />
      <rect x="9.9" y="3" width="4.2" height="12.5" rx="2.1" fill="currentColor" />
      <rect x="16.8" y="3" width="4.2" height="7.5" rx="2.1" fill="currentColor" />
      <rect
        x="12.9"
        y="16"
        width="6.6"
        height="4.4"
        rx="1.5"
        fill="hsl(var(--primary))"
        transform="rotate(-10 16.2 18.2)"
      />
    </svg>
  );
}

/**
 * Full logo lockup: mark + lowercase wordmark in the display face.
 * Size it through `className` on the wrapper (controls the gap/text) and
 * `markClassName` for the mark itself.
 */
export function DevPilotLogo({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <DevPilotMark className={cn("h-[18px] w-[18px]", markClassName)} />
      <span className="font-display text-base font-bold lowercase leading-none tracking-tight">
        devpilot
      </span>
    </span>
  );
}
