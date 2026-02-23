"use client";

// Friendly auth-failure card for the login page. Two sources feed it:
//   1. ?auth_error=<code> — stamped by our /auth/callback route.
//   2. The #error=…&error_code=…&error_description=… HASH fragment — Supabase's
//      implicit-flow errors never reach the server (fragments aren't sent), so
//      the raw fragment used to just sit in the address bar unexplained. We
//      parse it, show the same friendly copy, and scrub the hash from the URL.
//
// Config-class failures (bad OAuth secret, provider disabled) get a
// "Fix in setup" link to the exact wizard step; user-class ones offer a retry.

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CircleAlert, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AUTH_FIX_HREF,
  classifyAuthError,
  friendlyAuthErrorByCode,
  type FriendlyAuthError,
} from "@/lib/auth/oauth-errors";

export function AuthErrorNotice() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const paramCode = searchParams.get("auth_error");

  const [hashError, setHashError] = React.useState<FriendlyAuthError | null>(null);
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !/error/.test(hash)) return;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const error = params.get("error");
    const errorCode = params.get("error_code");
    const errorDescription = params.get("error_description");
    if (!error && !errorCode) return;
    setHashError(
      classifyAuthError({
        code: errorCode ?? error,
        description: errorDescription?.replace(/\+/g, " "),
      }),
    );
    // Scrub the fragment so a reload / copied URL doesn't re-show a stale error.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  const friendly = hashError ?? (paramCode ? friendlyAuthErrorByCode(paramCode) : null);
  if (!friendly || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    setHashError(null);
    if (paramCode) router.replace("/login");
  }

  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/10 mb-5 rounded-lg border px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <CircleAlert className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-destructive text-sm font-medium">{friendly.title}</p>
          <p className="text-destructive/80 mt-1 text-xs leading-relaxed">{friendly.message}</p>
          {friendly.configClass ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={AUTH_FIX_HREF}>
                  <Wrench className="h-3.5 w-3.5" />
                  Fix in setup
                </Link>
              </Button>
              <span className="text-muted-foreground text-[11px]">
                Operators: sign in with email below first, then the wizard opens on the right step.
              </span>
            </div>
          ) : null}
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
