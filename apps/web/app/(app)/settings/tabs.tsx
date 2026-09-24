"use client";

// Settings tab strip. Sits above each subpage's own header — the active tab
// is the heading, so we deliberately don't add another H1 in the layout.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Bell,
  Cpu,
  CreditCard,
  Github,
  GraduationCap,
  KeyRound,
  Lock,
  Palette,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

const TABS: ReadonlyArray<{ href: string; label: string; icon: LucideIcon }> = [
  { href: "/settings/setup", label: "Setup", icon: Wrench },
  { href: "/settings/appearance", label: "Appearance", icon: Palette },
  { href: "/settings/notifications", label: "Notifications", icon: Bell },
  { href: "/settings/agent-preferences", label: "Agent preferences", icon: GraduationCap },
  { href: "/settings/llm-auth", label: "LLM auth", icon: Cpu },
  { href: "/settings/api-keys", label: "API keys", icon: KeyRound },
  { href: "/settings/platform-secrets", label: "Platform secrets", icon: Lock },
  { href: "/settings/billing", label: "Billing", icon: CreditCard },
  { href: "/settings/github-integration", label: "GitHub", icon: Github },
  { href: "/settings/system-health", label: "System health", icon: Activity },
];

export function SettingsTabs() {
  const pathname = usePathname() ?? "";
  return (
    <div className="bg-background/60 border-b">
      {/* All 10 tabs need ~1200px on one line - wider than the max-w-6xl page
          body below, which is why the strip gets its own, wider column
          (85rem/1360px, comfortably past the ~1250px the tabs actually need)
          instead of inheriting the body's cap. flex-wrap (no overflow-x-auto,
          no shrink-0) is the fallback for widths that still can't fit one
          line: tabs wrap to a second row instead of scrolling, so every tab
          stays reachable without a horizontal-scroll gesture. */}
      <nav className="mx-auto flex max-w-[85rem] flex-wrap items-center gap-1 px-6">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:border-border border-transparent",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
