"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { ArrowRight, Github, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DevPilotLogo, DevPilotMark } from "@/components/shell/devpilot-mark";
import { Input } from "@/components/ui/input";
import { supabaseBrowser } from "@/lib/db/browser";
import { signInWithGithub } from "@/lib/auth/browser";
import { publicEnv } from "@/lib/env";
import { AuthErrorNotice } from "./auth-error-notice";

export function LoginClient({
  githubSignIn,
  localSignin = false,
  localError = null,
}: {
  /** False on a local install with no GitHub OAuth App yet (see page.tsx). */
  githubSignIn: boolean;
  /** True on a local install with instant sign-in: the email form POSTs to
   *  /auth/local and the visitor is signed in with no email sent. */
  localSignin?: boolean;
  /** A refusal from /auth/local, if the visitor was bounced back here. */
  localError?: string | null;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [githubStatus, setGithubStatus] = useState<"idle" | "redirecting">("idle");

  async function onGithubClick() {
    setGithubStatus("redirecting");
    setErrorMsg(null);
    try {
      await signInWithGithub(`${window.location.origin}/auth/callback`);
      // signInWithOAuth navigates the tab — nothing else to do here.
    } catch (e) {
      setGithubStatus("idle");
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg(null);
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
      return;
    }
    setStatus("sent");
  }

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* ── Form pane ─────────────────────────────────────────────────── */}
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Link
          href="/"
          aria-label="Back to the DevPilot home page"
          className="chrome-no-select w-fit"
        >
          <DevPilotLogo />
        </Link>

        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="font-display text-3xl font-extrabold tracking-tight">Sign in</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {localSignin
              ? "Local install: enter your email and you're in - nothing is sent, no passwords."
              : "Your board is waiting. We'll email you a one-time link - no passwords."}
          </p>

          <div className="mt-8">
            {/* Friendly OAuth/magic-link failure card (?auth_error= or #error= fragment). */}
            <Suspense fallback={null}>
              <AuthErrorNotice />
            </Suspense>
            {status === "sent" ? (
              <div className="border-success/30 bg-success/10 flex flex-col items-center gap-3 rounded-lg border px-4 py-6 text-center">
                <div className="bg-success/20 text-success flex h-10 w-10 items-center justify-center rounded-full">
                  <Mail className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-foreground text-sm font-medium">Check your inbox</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    We sent a sign-in link to <strong>{email}</strong>. Open it on this device to
                    continue.
                  </p>
                  {/* Local install (`pnpm setup:local` sets NEXT_PUBLIC_LOCAL_MAIL_URL):
                      nothing is emailed — the link is in Mailpit. Blank in prod → no hint. */}
                  {publicEnv.LOCAL_MAIL_URL ? (
                    <p className="text-muted-foreground mt-2 text-xs">
                      Local install: nothing is emailed — your link is waiting in{" "}
                      <a
                        href={publicEnv.LOCAL_MAIL_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground underline underline-offset-2"
                      >
                        Mailpit
                      </a>
                      .
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setStatus("idle");
                    setErrorMsg(null);
                  }}
                >
                  Use a different email
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {githubSignIn ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={onGithubClick}
                      disabled={githubStatus === "redirecting" || status === "sending"}
                      className="w-full"
                    >
                      {githubStatus === "redirecting" ? (
                        "Redirecting to GitHub…"
                      ) : (
                        <>
                          <Github className="h-4 w-4" />
                          Continue with GitHub
                        </>
                      )}
                    </Button>
                    <div className="relative flex items-center">
                      <div className="flex-1 border-t" aria-hidden />
                      <span className="text-muted-foreground px-3 font-mono text-[10px] uppercase tracking-[0.18em]">
                        or
                      </span>
                      <div className="flex-1 border-t" aria-hidden />
                    </div>
                  </>
                ) : null}
                {/* Local instant sign-in is a plain HTML POST: the server mints
                    the session and redirects, so no JS state is involved. */}
                <form
                  onSubmit={localSignin ? undefined : onSubmit}
                  method={localSignin ? "post" : undefined}
                  action={localSignin ? "/auth/local" : undefined}
                  className="flex flex-col gap-4"
                >
                  {localSignin ? <input type="hidden" name="next" value="/board" /> : null}
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="email" className="text-muted-foreground text-xs font-medium">
                      {localSignin ? "Email" : "Work email"}
                    </label>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      required
                      autoFocus
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      disabled={status === "sending"}
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={status === "sending" || email.trim().length === 0}
                    className="w-full"
                  >
                    {localSignin ? (
                      <>
                        Sign in <ArrowRight className="h-3.5 w-3.5" />
                      </>
                    ) : status === "sending" ? (
                      "Sending sign-in link…"
                    ) : (
                      <>
                        Send sign-in link <ArrowRight className="h-3.5 w-3.5" />
                      </>
                    )}
                  </Button>
                  {localError ? (
                    <p
                      role="alert"
                      className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
                    >
                      {localError}
                    </p>
                  ) : null}
                  {errorMsg ? (
                    <p
                      role="alert"
                      className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
                    >
                      {errorMsg}
                    </p>
                  ) : null}
                  <p className="text-muted-foreground text-center text-xs">
                    New here? Your workspace is created on first sign-in.
                  </p>
                </form>
              </div>
            )}
          </div>
        </div>

        <p className="text-muted-foreground text-xs">
          By signing in you agree to DevPilot&apos;s usage-based billing.{" "}
          <Link href="/" className="hover:text-foreground underline underline-offset-2">
            Back to home
          </Link>
        </p>
      </div>

      {/* ── Product pane — a quiet board moment (lg+) ─────────────────── */}
      <div className="bg-sidebar relative hidden overflow-hidden border-l lg:flex lg:flex-col lg:justify-center lg:px-16">
        {/* Faint lane guides, echoing the mark. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.55)_1px,transparent_1px)] bg-[size:120px_100%]"
        />

        <div className="relative max-w-md">
          <DevPilotMark className="h-8 w-8" />
          <p className="font-display mt-6 text-3xl font-extrabold leading-tight tracking-tight">
            The board your agents run.
          </p>
          <p className="text-muted-foreground mt-3 text-sm">
            PM scopes, Engineer builds, QA breaks, Security clears. Every handoff is a comment;
            every step is replayable.
          </p>

          {/* One ticket, four legs — the relay at a glance. */}
          <div className="bg-card mt-10 rounded-xl border p-4 shadow-[0_20px_50px_-28px_hsl(var(--foreground)/0.4)]">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground font-mono text-[10px]">CB-115</span>
              <span className="bg-success/10 text-success flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px]">
                <span
                  className="dp-anim-pulse bg-success inline-block h-1.5 w-1.5 rounded-full"
                  aria-hidden
                />
                in progress
              </span>
            </div>
            <div className="mt-1.5 text-sm font-medium">Wire up the audit log export</div>
            <ol className="mt-4 flex flex-col gap-2.5">
              <RelayRow tone="bg-chart-1" role="pm" note="spec written, work split" done />
              <RelayRow
                tone="bg-chart-4"
                role="engineer"
                note="diff open on devpilot/audit-export"
                done
              />
              <RelayRow tone="bg-chart-2" role="qa" note="running the suite now" active />
              <RelayRow tone="bg-chart-5" role="security" note="waiting on handoff" />
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

function RelayRow({
  tone,
  role,
  note,
  done,
  active,
}: {
  tone: string;
  role: string;
  note: string;
  done?: boolean;
  active?: boolean;
}) {
  return (
    <li
      className={`flex items-center gap-2.5 font-mono text-[11px] ${
        done || active ? "text-foreground/80" : "text-muted-foreground"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${tone} ${active ? "dp-anim-pulse" : ""} ${
          !done && !active ? "opacity-40" : ""
        }`}
        aria-hidden
      />
      <span className="w-16 shrink-0">{role}</span>
      <span className="text-muted-foreground truncate">{note}</span>
      {done ? <span className="text-success ml-auto">✓</span> : null}
    </li>
  );
}
