// Boot-setup shell — pre-auth, standalone (no app chrome, no session). Just
// the brand mark and a centered column: this screen exists before the database
// does, so it can't render anything that needs one.

import Link from "next/link";
import { DevPilotLogo } from "@/components/shell/devpilot-mark";

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-6 py-6 sm:px-10">
        <Link href="/" aria-label="DevPilot home" className="chrome-no-select w-fit">
          <DevPilotLogo />
        </Link>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 pb-20">{children}</main>
    </div>
  );
}
