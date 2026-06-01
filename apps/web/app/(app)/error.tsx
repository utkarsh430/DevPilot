"use client";

// Route error boundary for the authenticated app shell. Its main job is
// turning the config-failure class — "Missing required env var: X" thrown by
// lib/env's lazy getters — into a directed "finish setup" card instead of a
// blank crash. (Next redacts server error messages in production builds, so
// the env-var detection is best-effort.) Any other error is treated as an
// ordinary render/runtime bug, not a config problem — the copy and CTA
// shouldn't blame a missing credential for something ordinary.

import * as React from "react";
import Link from "next/link";
import { CircleAlert, LayoutGrid, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const MISSING_ENV_RE = /Missing required env var: ([A-Z][A-Z0-9_]*)/;

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[app] route error boundary:", error);
  }, [error]);

  const missingVar = MISSING_ENV_RE.exec(error.message ?? "")?.[1] ?? null;

  return (
    <div className="mx-auto max-w-xl px-6 py-20">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <div className="bg-destructive/10 text-destructive flex h-10 w-10 items-center justify-center rounded-full">
            <CircleAlert className="h-5 w-5" />
          </div>
          <div>
            <p className="font-display text-lg font-bold tracking-tight">
              {missingVar
                ? "This instance is missing configuration"
                : "Something broke on this page"}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {missingVar ? (
                <>
                  The server needs{" "}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                    {missingVar}
                  </code>{" "}
                  and it isn&apos;t set. The setup wizard walks through where to get it and saves it
                  for you.
                </>
              ) : (
                "The error has been logged on the server. Retrying usually clears a transient glitch — if it keeps happening, it's most likely a bug on this page rather than a configuration problem."
              )}
            </p>
            {error.digest ? (
              <p className="text-muted-foreground mt-2 font-mono text-[10px]">ref {error.digest}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {missingVar ? (
              <>
                <Button asChild size="sm" variant="primary">
                  <Link href="/settings/setup">
                    <Wrench className="h-3.5 w-3.5" />
                    Open setup
                  </Link>
                </Button>
                <Button size="sm" variant="outline" onClick={() => reset()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Try again
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="primary" onClick={() => reset()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Try again
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/board">
                    <LayoutGrid className="h-3.5 w-3.5" />
                    Back to board
                  </Link>
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
