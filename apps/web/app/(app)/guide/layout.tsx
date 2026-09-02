// The guide shell: a persistent left rail beside the article column.
//
// It sits INSIDE the existing `(app)` group, so it inherits the auth gate, the
// top bar, the project tabs and the toaster. Signed-in only is deliberate: the
// guide describes a workspace you have, every figure is a screenshot of the
// signed-in app, and putting it behind the same gate means no middleware change
// and no second layout chrome to keep in sync.
//
// The rail is `sticky` inside a scrollable main (`(app)/layout.tsx` gives
// `<main>` `overflow-y-auto`), which is what keeps chapter structure visible
// while a long section scrolls. Below `lg` it moves into the mobile sheet — a
// 240px rail plus a readable measure does not fit a phone.

import type { Metadata } from "next";
import { GuideSidebarNav } from "@/components/guide/sidebar";
import { GuideMobileNav } from "@/components/guide/mobile-nav";
import { ManualDownload } from "@/components/guide/manual-download";

export const metadata: Metadata = {
  title: "Guide",
  description: "How DevPilot works, and how to get work through it.",
};

export default function GuideLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-w-0 max-w-6xl gap-8 px-6 py-8">
      {/* `shrink-0` so the rail keeps its width and the article column absorbs
          the difference; `min-w-0` on the article so long code and tables shrink
          inside their own scroll boxes rather than widening the page. */}
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-6 max-h-[calc(100vh-6rem)] overflow-y-auto pb-6">
          <GuideSidebarNav />
          <div className="border-border mt-6 border-t pt-4">
            <ManualDownload />
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mb-4 lg:hidden">
          <GuideMobileNav />
        </div>
        {children}
      </div>
    </div>
  );
}
