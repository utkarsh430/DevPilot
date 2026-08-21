"use client";

// The Vercel connection card — a read-only, truthful report of what is and is
// not set up.
//
// This card IS the user-facing value of the credential work. The operator's
// complaint was "I don't see anywhere to put the credential and I don't know
// what's missing", so a generic "not connected" here would be a failure of its
// purpose. Every non-ok row therefore renders the specific problem AND a link
// to the exact page that fixes it; the wording comes from the pure rules in
// `lib/vercel/preflight.ts`, not from this component.
//
// Auto-runs on mount only when a token is configured. With no token there is
// nothing to ask Vercel and the static "add a token" state is the honest
// answer — firing a doomed request would just make the page slower.

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  Link2,
  Link2Off,
  RefreshCw,
  Rocket,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import type { VercelConnectionStatus } from "@/lib/vercel/connection";
import type { PreflightCheck, PreflightLevel, PreflightReport } from "@/lib/vercel/preflight";
import {
  disconnectVercelAction,
  runVercelPreflightAction,
  startVercelConnectAction,
} from "./vercel-actions";

const LEVEL_ICON: Record<PreflightLevel, React.ComponentType<{ className?: string }>> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
  unknown: CircleHelp,
};

const LEVEL_CLASS: Record<PreflightLevel, string> = {
  ok: "text-[var(--chart-3)]",
  warn: "text-[var(--chart-4)]",
  error: "text-destructive",
  unknown: "text-muted-foreground",
};

function ScopeBadge({ report }: { report: PreflightReport }) {
  const { scope } = report;
  if (scope.kind === "team") {
    return <Badge tone="info">Team · {scope.name ?? scope.slug ?? scope.teamId}</Badge>;
  }
  if (scope.kind === "personal") {
    return <Badge tone="info">Personal · {scope.username ?? scope.email ?? "account"}</Badge>;
  }
  return <Badge tone="muted">Scope unknown</Badge>;
}

function CheckRow({ check }: { check: PreflightCheck }) {
  const Icon = LEVEL_ICON[check.level];
  return (
    <li className="flex gap-2.5">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", LEVEL_CLASS[check.level])} />
      <div className="min-w-0">
        <div className="text-sm font-medium">{check.label}</div>
        <p className="text-muted-foreground text-[11px] leading-snug">{check.detail}</p>
        {check.remedy ? (
          <p className="text-foreground/80 mt-1 text-[11px] leading-snug">
            {check.remedy}
            {check.remedyHref ? (
              <>
                {" "}
                <a
                  href={check.remedyHref}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-0.5 underline underline-offset-2"
                >
                  Open
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** Provenance badge — the answer to "is this connection real, or am I still on
 *  a token I pasted months ago?". That question is the operator's whole stated
 *  reason for wanting the connect flow, so it gets a badge rather than a line of
 *  body copy. */
function SourceBadge({ report }: { report: PreflightReport }) {
  if (report.credentialSource === "oauth") return <Badge tone="ok">Connected</Badge>;
  if (report.credentialSource === "pasted") return <Badge tone="muted">Pasted token</Badge>;
  return null;
}

export function VercelPreflightCard({
  tokenConfigured,
  isOperator,
  connection,
  integrationConfigured,
}: {
  tokenConfigured: boolean;
  isOperator: boolean;
  /** Metadata only — this prop never carries a token. */
  connection: VercelConnectionStatus;
  /** Whether the three integration keys are set. Gates the Connect button so an
   *  operator is told what is missing instead of being sent to a 404 install
   *  page on vercel.com. */
  integrationConfigured: boolean;
}) {
  const [report, setReport] = React.useState<PreflightReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [ran, setRan] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [connectNote, setConnectNote] = React.useState<string | null>(null);
  const [connected, setConnected] = React.useState(connection.connected);
  const [callbackUrl, setCallbackUrl] = React.useState<string | null>(null);

  const run = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    const res = await runVercelPreflightAction();
    setBusy(false);
    setRan(true);
    if (res.ok) setReport(res.value);
    else {
      setReport(null);
      setError(res.error);
    }
  }, []);

  React.useEffect(() => {
    if (tokenConfigured && isOperator && !ran) void run();
  }, [tokenConfigured, isOperator, ran, run]);

  // The popup reports its outcome by posting to THIS window. Accept the message
  // only from our own origin: a message from anywhere else is not our callback,
  // and acting on it would let any page that can open this one drive the UI into
  // reporting a connection that does not exist.
  React.useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { type?: string; ok?: boolean; message?: string } | null;
      if (!data || data.type !== "devpilot:vercel-connect") return;
      setConnecting(false);
      setConnectNote(data.message ?? null);
      if (data.ok) {
        setConnected(true);
        // Re-run the preflight so the card reports the LIVE identity of the new
        // credential rather than echoing what the popup claimed.
        setRan(false);
        void run();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [run]);

  const connect = React.useCallback(async () => {
    setConnecting(true);
    setConnectNote(null);
    const res = await startVercelConnectAction();
    if (!res.ok) {
      setConnecting(false);
      setConnectNote(res.error);
      return;
    }
    setCallbackUrl(res.value.callbackUrl);
    // Vercel runs the install in a popup and monitors when it closes.
    const popup = window.open(
      res.value.installUrl,
      "devpilot-vercel-connect",
      "width=680,height=820",
    );
    if (!popup) {
      setConnecting(false);
      setConnectNote(
        "The browser blocked the Vercel install popup. Allow popups for this site and try again.",
      );
      return;
    }
    // An operator who closes the popup without finishing posts no message, so
    // without this poll the button would stay disabled until a page reload —
    // a dead end with no error to explain it. `closed` is readable
    // cross-origin; nothing else about the popup is touched.
    const poll = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(poll);
      // A completed install posts its message before closing and has already
      // cleared `connecting`, so reaching here still busy means abandoned.
      setConnecting((busyNow) => {
        if (busyNow) {
          setConnectNote(
            "The Vercel window was closed before the connection completed. Nothing was changed — you can try again.",
          );
        }
        return false;
      });
    }, 500);
  }, []);

  const disconnect = React.useCallback(async () => {
    setConnecting(true);
    const res = await disconnectVercelAction();
    setConnecting(false);
    if (!res.ok) {
      setConnectNote(res.error);
      return;
    }
    setConnected(false);
    setConnectNote(
      "Disconnected locally. DevPilot no longer holds the credential — but the integration is still installed on your Vercel account. Uninstall it under Vercel ▸ Integrations if you want the grant withdrawn too.",
    );
    setRan(false);
    void run();
  }, [run]);

  return (
    <section className="border-border bg-card/40 mb-7 rounded-lg border p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Rocket className="text-muted-foreground h-4 w-4" />
            <h2 className="text-sm font-semibold">Vercel connection</h2>
            {report ? (
              <>
                <SourceBadge report={report} />
                <ScopeBadge report={report} />
                {report.ready ? (
                  <Badge tone="ok">Ready to deploy</Badge>
                ) : (
                  <Badge tone="warn">Setup incomplete</Badge>
                )}
              </>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1 max-w-2xl text-[11px] leading-snug">
            Checks the Vercel credential below against Vercel&apos;s API — which account it resolves
            to, and whether the Vercel for GitHub App is installed. Installing that App is a browser
            grant that no API token can perform, so this check is the only way to know it is done.
          </p>
        </div>
        {isOperator ? (
          <div className="flex flex-wrap items-center gap-2">
            {connected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void disconnect()}
                disabled={connecting}
              >
                <Link2Off className="h-3.5 w-3.5" />
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void connect()}
                disabled={connecting || !integrationConfigured}
                title={
                  integrationConfigured
                    ? undefined
                    : "Set the Vercel integration client ID, client secret and slug below first."
                }
              >
                <Link2 className="h-3.5 w-3.5" />
                {connecting ? "Connecting…" : "Connect Vercel"}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void run()} disabled={busy}>
              <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
              {busy ? "Checking…" : "Re-check"}
            </Button>
          </div>
        ) : null}
      </header>

      {isOperator && connectNote ? (
        <p className="text-foreground/80 mt-2 text-[11px] leading-snug">{connectNote}</p>
      ) : null}
      {isOperator && callbackUrl && !connected ? (
        <p className="text-muted-foreground mt-2 text-[11px] leading-snug">
          This instance&apos;s Redirect URL — it must match the one registered in Vercel&apos;s
          Integration Console exactly:{" "}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">{callbackUrl}</code>
        </p>
      ) : null}
      {isOperator && !integrationConfigured && !connected ? (
        <p className="text-muted-foreground mt-2 text-[11px] leading-snug">
          To enable one-click connect, create an integration in Vercel&apos;s Integration Console
          and add its client ID, client secret and slug under{" "}
          <span className="font-medium">Deployment</span> below. Until then, pasting a Vercel API
          token works exactly as before.
        </p>
      ) : null}

      <div className="mt-3">
        {!isOperator ? (
          <p className="text-muted-foreground text-[11px]">
            Only an instance operator can view or change the Vercel connection.
          </p>
        ) : !tokenConfigured && !report ? (
          <p className="text-muted-foreground text-[11px]">
            No Vercel credential is configured yet. Use{" "}
            <span className="font-medium">Connect Vercel</span> above, or add a token in the{" "}
            <span className="font-medium">Deployment</span> section below — either way this check
            will run automatically.
          </p>
        ) : busy && !report ? (
          <p className="text-muted-foreground text-[11px]">Checking Vercel…</p>
        ) : error ? (
          <p className="text-destructive text-[11px]">{error}</p>
        ) : report ? (
          <ul className="space-y-2.5">
            {report.checks.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
