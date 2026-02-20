"use client";

// Last-resort error boundary — replaces the ROOT layout when even it throws
// (e.g. boot-level config problems outside the middleware guard's reach). It
// must render its own <html>/<body> and import the stylesheet itself: the root
// layout that normally provides both is the thing that failed.

import "./globals.css";

import * as React from "react";

const MISSING_ENV_RE = /Missing required env var: ([A-Z][A-Z0-9_]*)/;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[app] global error boundary:", error);
  }, [error]);

  const missingVar = MISSING_ENV_RE.exec(error.message ?? "")?.[1] ?? null;

  return (
    <html lang="en">
      <body className="bg-background text-foreground min-h-screen font-sans antialiased">
        <div className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
          <p className="text-destructive font-mono text-xs uppercase tracking-[0.18em]">
            devpilot · instance error
          </p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight">
            {missingVar ? "This instance is missing configuration" : "DevPilot couldn't render"}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            {missingVar ? (
              <>
                The server needs{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                  {missingVar}
                </code>{" "}
                and it isn&apos;t set. If sign-in still works, open{" "}
                <a href="/settings/setup" className="underline underline-offset-2">
                  Settings → Setup
                </a>{" "}
                to add it; otherwise edit{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                  apps/web/.env.local
                </code>{" "}
                on the host and restart.
              </>
            ) : (
              "An unrecoverable error stopped this page from rendering. It's been logged on the server — retrying usually clears a transient glitch; if it keeps happening, it's most likely a bug rather than a configuration problem."
            )}
          </p>
          {error.digest ? (
            <p className="text-muted-foreground mt-3 font-mono text-[10px]">ref {error.digest}</p>
          ) : null}
          <div className="mt-6 flex items-center gap-3">
            <button
              type="button"
              onClick={() => reset()}
              className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium"
            >
              Try again
            </button>
            <a
              href="/settings/setup"
              className="border-border text-foreground rounded-md border px-3 py-1.5 text-sm font-medium"
            >
              Open setup
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
