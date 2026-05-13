"use client";

// Phase 2 / M5a — GitHub integration settings client UI.
//
// Two render branches:
//   - connected   → show the GitHub login, scopes, expiry, Disconnect button.
//   - disconnected → show a "Continue with GitHub" CTA that kicks the
//                    Supabase Auth OAuth flow with the right scope set + a
//                    redirectTo that lands the user back on this page.
//
// The OAuth handshake runs in the browser (Supabase Auth's signInWithOAuth
// sets a PKCE cookie pre-redirect), so this lives client-side. The callback
// handler at /auth/callback then persists the provider_token via A2's
// `persistGithubTokenFromSession` and routes back here.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Github,
  Loader2,
  Trash2,
  Unplug,
  Wrench,
  X,
} from "lucide-react";
import { AUTH_FIX_HREF, classifyAuthError, friendlyAuthErrorByCode } from "@/lib/auth/oauth-errors";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { supabaseBrowser } from "@/lib/db/browser";
import type { GithubProviderReadiness } from "@/lib/github/provider-readiness";
import {
  adviseGithubConnection,
  GITHUB_OAUTH_SCOPE_LIST,
  GITHUB_OAUTH_SCOPES,
  GITHUB_SCOPE_PURPOSE,
  parseGrantedScopes,
  type GithubOAuthScope,
} from "@/lib/github/scopes";
import { disconnectGithubAction } from "./actions";

export type GithubConnectionStatus =
  | {
      connected: true;
      githubLogin: string;
      scopes: string;
      expiresAt: string | null;
    }
  | { connected: false };

/** Shared, dependency-free source of truth - see `lib/github/scopes.ts`. The
 *  literal used to be duplicated here (plus once more, by hand, as the badge
 *  list below) to keep the server-only oauth.ts out of the client bundle. */
const REQUESTED_SCOPES = GITHUB_OAUTH_SCOPE_LIST;

export type GithubCallbackError = {
  /** Stable friendly code (see lib/auth/oauth-errors) — null for legacy raw-only errors. */
  code: string | null;
  /** Short raw detail from the callback, for the fine print. */
  detail: string | null;
};

/**
 * Kick the Supabase GitHub OAuth handshake with the CURRENT scope set.
 *
 * Shared by the first-time Connect button and the Reconnect button, so a
 * re-authorisation can never ask for a different (older) set than a fresh one.
 * GitHub shows its consent screen again whenever the requested scopes exceed
 * what it already granted, and `/auth/callback` upserts the row - which is what
 * makes "reconnect" the whole fix for an under-scoped token.
 */
async function startGithubOAuth(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = supabaseBrowser();
  const redirectTo =
    typeof window !== "undefined"
      ? `${window.location.origin}/auth/callback?next=/settings/github-integration`
      : "/settings/github-integration";

  const { error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { scopes: GITHUB_OAUTH_SCOPES, redirectTo },
  });
  if (error) return { ok: false, error: error.message };
  // On success Supabase redirects the browser to GitHub; nothing else to do.
  return { ok: true };
}

export function GithubIntegrationClient({
  status,
  providerSetup = { ready: true },
  callbackError = null,
}: {
  status: GithubConnectionStatus;
  /** Whether GoTrue's GitHub provider can actually complete a handshake on
   *  this install. Server-derived; absent means "assume it can". */
  providerSetup?: GithubProviderReadiness;
  callbackError?: GithubCallbackError | null;
}) {
  const advice = adviseGithubConnection(
    status.connected ? { connected: true, scopes: status.scopes } : { connected: false },
  );

  return (
    <div className="space-y-4">
      {callbackError ? <CallbackErrorCard error={callbackError} /> : null}
      {advice.state === "reconnect_required" ? <ReconnectRequiredCard advice={advice} /> : null}
      {status.connected ? (
        <ConnectedCard status={status} />
      ) : providerSetup.ready ? (
        <DisconnectedCard />
      ) : (
        <LocalSetupCard setup={providerSetup} />
      )}
    </div>
  );
}

// ─── local install, provider not configured ──────────────────────────────

/**
 * What a fresh local install shows INSTEAD of the Connect button. Without
 * this, the button sends the browser to GitHub with the literal
 * `client_id=env(SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID)` and the operator
 * reads a GitHub 404 that names nothing they did. The card names the one
 * thing to do, with the exact callback URL - a wrong callback fails at the
 * end of the dance with GitHub's generic "redirect_uri mismatch".
 */
function LocalSetupCard({ setup }: { setup: Extract<GithubProviderReadiness, { ready: false }> }) {
  return (
    <Card data-testid="github-local-setup">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wrench className="h-4 w-4" />
          GitHub isn&apos;t set up on this local install yet
        </CardTitle>
        <CardDescription className="text-xs">
          Every project is a GitHub repo, so DevPilot needs a GitHub OAuth App of your own that
          points at your local Supabase. One-time, about two minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground space-y-3 text-sm">
        <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed">
          <li>
            Open{" "}
            <a
              href="https://github.com/settings/developers"
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-foreground underline"
            >
              github.com/settings/developers
            </a>{" "}
            → <strong>OAuth Apps</strong> → <strong>New OAuth App</strong>.
          </li>
          <li>
            Homepage URL: <code className="bg-muted rounded px-1 font-mono">{appOrigin()}</code>
            <br />
            Authorization callback URL:{" "}
            <code className="bg-muted rounded px-1 font-mono">{setup.callbackUrl}</code>
          </li>
          <li>
            Generate a client secret, then in the repo run:
            <pre className="bg-muted mt-1.5 overflow-x-auto rounded px-2 py-1.5 font-mono text-[11px]">
              {setup.command}
            </pre>
          </li>
        </ol>
        <p className="text-xs">
          That writes the keys and restarts the local Supabase; reload this page afterwards and the
          Connect button appears.
        </p>
      </CardContent>
    </Card>
  );
}

function appOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3000";
}

/**
 * The connection works, but its grant is missing a scope DevPilot now needs.
 *
 * Rendered ABOVE the connected card because the connected card's job is to say
 * "you're set up" - and right now that would be the wrong headline. This is the
 * surface that exists so the operator learns about the gap here, rather than
 * from a land that fails at push time hours later.
 */
function ReconnectRequiredCard({
  advice,
}: {
  advice: Extract<ReturnType<typeof adviseGithubConnection>, { state: "reconnect_required" }>;
}) {
  const [busy, setBusy] = React.useState(false);
  const unknown = advice.reason === "scopes_unknown";
  const missingWorkflow = advice.missing.includes("workflow");

  async function onReconnect() {
    setBusy(true);
    const res = await startGithubOAuth();
    if (!res.ok) {
      setBusy(false);
      toast.error("Couldn't start GitHub OAuth", { description: res.error });
    }
  }

  return (
    <div
      role="alert"
      className="border-warning/30 bg-warning/10 rounded-lg border px-4 py-3"
      data-testid="github-reconnect-required"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-warning text-sm font-medium">Reconnect GitHub to finish the upgrade</p>
          <p className="text-warning/90 mt-1 text-xs leading-relaxed">
            {unknown ? (
              <>
                DevPilot couldn&apos;t confirm which scopes your stored GitHub grant carries, so it
                can&apos;t tell whether pushes that touch CI will work. Reconnecting re-captures
                them and takes a few seconds.
              </>
            ) : missingWorkflow ? (
              <>
                Your connection still works for normal pushes, but it was authorised before DevPilot
                requested the <code className="bg-warning/15 rounded px-1 font-mono">workflow</code>{" "}
                scope. Existing tokens don&apos;t gain new scopes on their own. Until you reconnect,
                GitHub will <strong>reject any push that adds or edits a file under</strong>{" "}
                <code className="bg-warning/15 rounded px-1 font-mono">.github/workflows/</code> -
                so tickets that set up CI can never land.
              </>
            ) : (
              <>
                Your connection is missing {advice.missing.length === 1 ? "a scope" : "some scopes"}{" "}
                DevPilot now requests. Reconnecting re-authorises with the current set.
              </>
            )}
          </p>
          {advice.missing.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-warning/80 text-[11px]">Missing:</span>
              {advice.missing.map((s) => (
                <Badge key={s} tone="warn" className="font-mono text-[10px]">
                  {s}
                </Badge>
              ))}
            </div>
          ) : null}
          {missingWorkflow ? (
            <p className="text-warning/80 mt-2 text-xs leading-relaxed">
              <strong>What you&apos;re granting:</strong> {GITHUB_SCOPE_PURPOSE.workflow} Whoever
              can edit CI can cause CI to run arbitrary code with that repository&apos;s Actions
              secrets. That is a genuine widening of this integration&apos;s reach, and it is the
              trade for agents being able to set up CI at all.
            </p>
          ) : null}
          <div className="mt-2.5">
            <Button variant="primary" size="sm" onClick={onReconnect} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Redirecting…
                </>
              ) : (
                <>
                  <Github className="h-3.5 w-3.5" />
                  Reconnect GitHub
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Friendly rendering of ?error_code= / ?error= from the auth callback — the
 *  "connected your account but couldn't store the token" class of failure. */
function CallbackErrorCard({ error }: { error: GithubCallbackError }) {
  const router = useRouter();
  const [dismissed, setDismissed] = React.useState(false);
  if (dismissed) return null;

  const friendly = error.code
    ? friendlyAuthErrorByCode(error.code)
    : classifyAuthError({ message: error.detail });

  function dismiss() {
    setDismissed(true);
    router.replace("/settings/github-integration");
  }

  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/10 rounded-lg border px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <CircleAlert className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-destructive text-sm font-medium">
            {friendly.code === "unknown" ? "Connecting GitHub didn't finish" : friendly.title}
          </p>
          <p className="text-destructive/80 mt-1 text-xs leading-relaxed">
            {friendly.code === "unknown"
              ? "You're signed in, but DevPilot couldn't store your GitHub token — so agents can't clone or push yet. Try connecting again."
              : friendly.message}
          </p>
          {error.detail ? (
            <p className="text-muted-foreground mt-1.5 font-mono text-[10px]">{error.detail}</p>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {friendly.configClass ? (
              <Button asChild size="sm" variant="outline">
                <Link href={AUTH_FIX_HREF}>
                  <Wrench className="h-3.5 w-3.5" />
                  Fix in setup
                </Link>
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Try again below
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="text-destructive/60 hover:text-destructive shrink-0 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ─── disconnected ─────────────────────────────────────────────────────────

function DisconnectedCard() {
  const [busy, setBusy] = React.useState(false);

  async function onConnect() {
    setBusy(true);
    const res = await startGithubOAuth();
    if (!res.ok) {
      setBusy(false);
      toast.error("Couldn't start GitHub OAuth", { description: res.error });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Github className="h-4 w-4" />
          Not connected
        </CardTitle>
        <CardDescription className="text-xs">
          Connect your GitHub account to enable per-project repos and review-and-push.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">
        <p className="mb-2">We&apos;ll request the following OAuth scopes:</p>
        {/* Derived from the shared list, so the badges cannot drift from what
            the handshake above actually asks for. */}
        <ul className="space-y-1.5">
          {REQUESTED_SCOPES.map((s: GithubOAuthScope) => (
            <li key={s} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
              <Badge tone="info" className="font-mono text-[10px]">
                {s}
              </Badge>
              <span className="text-muted-foreground flex-1 basis-64">
                {GITHUB_SCOPE_PURPOSE[s]}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs">
          <code className="bg-muted rounded px-1 font-mono">workflow</code> is the widest of these:
          it lets DevPilot create and change GitHub Actions workflow files in repos it can already
          write to, and anyone who can edit CI can make CI run arbitrary code. It is requested
          because DevPilot&apos;s agents set up CI, and GitHub rejects <em>any</em> push touching{" "}
          <code className="bg-muted rounded px-1 font-mono">.github/workflows/</code> without it.
        </p>
      </CardContent>
      <CardFooter className="border-t pt-4">
        <Button variant="primary" size="sm" onClick={onConnect} disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Redirecting…
            </>
          ) : (
            <>
              <Github className="h-3.5 w-3.5" />
              Continue with GitHub
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}

// ─── connected ────────────────────────────────────────────────────────────

function formatExpiresAt(iso: string | null): string {
  if (!iso) return "never expires";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diff = d.getTime() - now;
  if (diff <= 0) {
    return `expired ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return `expires ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function ConnectedCard({
  status,
}: {
  status: Extract<GithubConnectionStatus, { connected: true }>;
}) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [avatarFailed, setAvatarFailed] = React.useState(false);
  // Catch avatars that already errored before hydration attached onError —
  // a complete img with no pixels is a failed load, not a slow one.
  const avatarRef = React.useCallback((node: HTMLImageElement | null) => {
    if (node && node.complete && node.naturalWidth === 0) setAvatarFailed(true);
  }, []);
  const scopes = parseGrantedScopes(status.scopes);
  const advice = adviseGithubConnection({ connected: true, scopes: status.scopes });
  const missing = advice.state === "reconnect_required" ? advice.missing : [];
  const avatarUrl = `https://github.com/${encodeURIComponent(status.githubLogin)}.png?size=64`;

  async function onDisconnect() {
    setBusy(true);
    const res = await disconnectGithubAction();
    setBusy(false);
    setConfirmOpen(false);
    if (!res.ok) {
      toast.error("Disconnect failed", { description: res.error });
      return;
    }
    toast.success("GitHub disconnected", {
      description:
        "Revoke DevPilot on github.com/settings/applications too if you want a full clean-up.",
    });
    // Hard-reload so the page re-renders the disconnected branch from the
    // server. router.refresh() works too but the full reload also clears any
    // stale Supabase session state.
    if (typeof window !== "undefined") window.location.reload();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="text-success h-4 w-4" />
          Connected
        </CardTitle>
        <CardDescription className="text-xs">
          DevPilot will use this token for every project clone, push, and PR.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Identity */}
        <div className="bg-muted/30 flex items-center gap-3 rounded-md border p-3">
          {/* Avatar is best-effort and must never gate the page: the
              initial-letter block renders immediately and the lazy image
              (excluded from the window load event) paints over it if and
              when GitHub's CDN answers. onError drops a broken img for good. */}
          <span className="bg-muted relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border">
            <span aria-hidden className="text-muted-foreground text-sm font-semibold uppercase">
              {status.githubLogin.charAt(0)}
            </span>
            {!avatarFailed ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={avatarRef}
                src={avatarUrl}
                alt={`${status.githubLogin}'s GitHub avatar`}
                width={40}
                height={40}
                loading="lazy"
                decoding="async"
                className="bg-background absolute inset-0 h-full w-full rounded-full object-cover"
                onError={() => setAvatarFailed(true)}
              />
            ) : null}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">@{status.githubLogin}</p>
            <a
              href={`https://github.com/${encodeURIComponent(status.githubLogin)}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-muted-foreground hover:text-foreground text-xs hover:underline"
            >
              github.com/{status.githubLogin}
            </a>
          </div>
          <Badge tone="ok" className="uppercase">
            Active
          </Badge>
        </div>

        {/* Scopes */}
        <div>
          <p className="text-muted-foreground mb-1 text-[11px] font-medium uppercase tracking-wide">
            Scopes
          </p>
          {scopes.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {scopes.map((s) => (
                <Badge key={s} tone="info" className="font-mono text-[10px]">
                  {s}
                </Badge>
              ))}
              {/* Requested-but-not-granted scopes, shown alongside so the list
                  answers "what does this token have" AND "what is it short of". */}
              {missing.map((s) => (
                <Badge key={s} tone="warn" className="font-mono text-[10px]">
                  {s} - not granted
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              No scopes recorded. Reconnect to recapture them.
            </p>
          )}
        </div>

        {/* Expiry */}
        <div>
          <p className="text-muted-foreground mb-1 text-[11px] font-medium uppercase tracking-wide">
            Token validity
          </p>
          <p className="text-muted-foreground text-xs">{formatExpiresAt(status.expiresAt)}</p>
        </div>

        {/* Reminder about revoking on GitHub side */}
        <div className="border-warning/30 bg-warning/10 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 translate-y-px" />
          <p>
            Disconnect here drops DevPilot&apos;s copy of your token. To fully revoke access on
            GitHub&apos;s side, visit{" "}
            <a
              href="https://github.com/settings/applications"
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-foreground underline"
            >
              github.com/settings/applications
            </a>{" "}
            and remove the DevPilot OAuth app.
          </p>
        </div>
      </CardContent>
      <CardFooter className="justify-end border-t pt-4">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={busy}
        >
          <Unplug className="h-3.5 w-3.5" />
          Disconnect
        </Button>
      </CardFooter>

      {/* Disconnect confirmation */}
      <Dialog open={confirmOpen} onOpenChange={(o) => (busy ? null : setConfirmOpen(o))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect GitHub?</DialogTitle>
            <DialogDescription>
              DevPilot will stop being able to clone, push, or open PRs against any project repo
              until you reconnect. In-flight runs may fail when their next git operation runs.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onDisconnect} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Disconnecting…
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  Disconnect
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
