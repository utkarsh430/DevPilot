// GET /setup/api/status — drives the boot wizard's polling loop. Pre-auth by
// necessity (no Supabase env ⇒ no sessions), so it returns ONLY booleans:
// which boot keys exist, never their values. On a configured instance it
// collapses to `{ configured: true }` and the wizard shows its exit card.
//
// Polling this route is also what re-prints the token banner after a dev-server
// restart — the operator never has to scroll back through old logs.

import { NextResponse } from "next/server";
import { bootEnvPresence, isBootConfigured } from "@/lib/setup/boot-status";
import { printSetupBannerOnce } from "@/lib/setup/setup-token";
import { isServerlessHost, locateEnvFile } from "@/lib/setup/env-file";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isBootConfigured()) {
    return NextResponse.json({ configured: true }, { headers: { "cache-control": "no-store" } });
  }

  // The token banner is meaningless on serverless hosts: the token station is
  // bypassed there (write/validate are hard-disabled), and each lambda would
  // print its own token anyway.
  if (!isServerlessHost()) printSetupBannerOnce();

  let envFileFound: boolean | null = null;
  try {
    envFileFound = locateEnvFile().exists;
  } catch {
    envFileFound = null;
  }

  return NextResponse.json(
    {
      configured: false,
      presence: bootEnvPresence(),
      serverless: isServerlessHost(),
      // Prod servers don't hot-reload .env.local — the wizard shows a
      // restart-and-rebuild card instead of polling forever.
      prodBuild: process.env.NODE_ENV === "production",
      envFileFound,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
