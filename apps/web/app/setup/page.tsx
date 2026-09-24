// First-run setup — the boot wizard. Reached (via the middleware boot guard)
// whenever the Supabase boot env is missing; a configured instance renders a
// polite dead-end instead, so the surface can't be used to reconfigure a live
// install (that's Settings → Setup, behind auth).

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { bootEnvPresence, isBootConfigured } from "@/lib/setup/boot-status";
import { isServerlessHost } from "@/lib/setup/env-file";
import { BootSetupClient } from "./boot-setup-client";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  if (isBootConfigured()) {
    return (
      <div className="py-16">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <div className="bg-success/10 text-success flex h-10 w-10 items-center justify-center rounded-full">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <p className="font-display text-lg font-bold tracking-tight">
                This instance is already set up
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                First-run setup is locked once the boot configuration exists. Credentials are
                managed in Settings → Setup after you sign in.
              </p>
            </div>
            <Button asChild variant="primary" size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <BootSetupClient
      initialPresence={bootEnvPresence()}
      serverless={isServerlessHost()}
      prodBuild={process.env.NODE_ENV === "production"}
    />
  );
}
