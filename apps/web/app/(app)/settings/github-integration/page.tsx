// Phase 2 / M5a — GitHub integration settings page.
//
// Server component: fetches the user's GitHub token row (decrypted by A2's
// `getGithubTokenRow`) and hands the safe-to-expose fields to
// <GithubIntegrationClient />. We never pass the access_token across the
// server/client boundary — only the metadata the UI needs to render the
// "connected as" indicator.

import { Github } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { getGithubTokenRow } from "@/lib/github/oauth";
import { githubProviderReadinessFromEnv } from "@/lib/github/provider-readiness";
import { GithubIntegrationClient, type GithubConnectionStatus } from "./github-integration-client";

export const dynamic = "force-dynamic";

export default async function GithubIntegrationPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; error_code?: string }>;
}) {
  const user = await requireUser();
  await requireTenantId();
  const sp = (await searchParams) ?? {};

  const row = await getGithubTokenRow(user.id);

  // Strip accessToken before crossing into the client component. The client
  // never needs it (server actions look it up server-side via the user id).
  const status: GithubConnectionStatus = row
    ? {
        connected: true,
        githubLogin: row.githubLogin,
        scopes: row.scopes,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      }
    : { connected: false };

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="bg-muted text-muted-foreground flex h-8 w-8 items-center justify-center rounded-md">
              <Github className="h-4 w-4" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight">GitHub integration</h1>
          </div>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            DevPilot uses your GitHub account to clone project repos, push agent commits, and open
            pull requests on your behalf. We never store your password — only an OAuth token, which
            you can revoke at any time from{" "}
            <a
              href="https://github.com/settings/applications"
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-foreground underline"
            >
              github.com/settings/applications
            </a>
            .
          </p>
        </div>
      </header>
      <GithubIntegrationClient
        status={status}
        // Local install with no OAuth App yet → a setup card instead of a
        // Connect button that lands on a GitHub 404 (lib/github/provider-readiness).
        providerSetup={githubProviderReadinessFromEnv()}
        callbackError={
          sp.error_code || sp.error
            ? { code: sp.error_code ?? null, detail: sp.error ?? null }
            : null
        }
      />
    </div>
  );
}
