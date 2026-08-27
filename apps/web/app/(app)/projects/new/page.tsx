// Phase 2 / M5a–M5b — New project page.
//
// Server-side gate: if the operator hasn't connected GitHub, we don't render
// the connect/create form at all — we surface an interstitial that points at
// the settings page. The form's actions both require a github token, so this
// keeps the failure mode visible at landing time rather than mid-submit.

import Link from "next/link";
import { Github, ExternalLink } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { getGithubTokenRow } from "@/lib/github/oauth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NewProjectClient } from "./new-project-client";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const user = await requireUser();
  await requireTenantId();

  const row = await getGithubTokenRow(user.id);
  if (!row) {
    return <ConnectGithubInterstitial />;
  }

  return <NewProjectClient githubLogin={row.githubLogin} />;
}

function ConnectGithubInterstitial() {
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="bg-muted text-muted-foreground flex h-8 w-8 items-center justify-center rounded-md">
              <Github className="h-4 w-4" />
            </div>
            <CardTitle className="text-base">Connect GitHub first</CardTitle>
          </div>
          <CardDescription className="mt-2">
            DevPilot needs a GitHub token to clone your repo (or create a new one) and push the
            agents&apos; work for you. Connect once and we&apos;ll reuse it for every project.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>
            You&apos;ll authorize the same GitHub account you sign into DevPilot with. We request{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">repo</code>,{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">read:user</code>,
            and{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">user:email</code>{" "}
            so private repos work and commits are attributable to you.
          </p>
        </CardContent>
        <CardFooter className="border-t pt-4">
          <Button asChild variant="primary" size="sm">
            <Link href="/settings/github-integration">
              <Github className="h-3.5 w-3.5" />
              Open GitHub integration
              <ExternalLink className="h-3 w-3 opacity-60" />
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
