"use client";

// Boot-wizard client. Four stations: unlock with the console token, point at a
// Supabase project (live-validated), mint the secrets master key, then write
// apps/web/.env.local atomically and watch the status flip. Values only ever
// travel browser → this host's own /setup API — never to a third party.

import * as React from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, KeyRound, Loader2, LockOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { StepCard } from "@/components/setup/step-card";
import { CommandLine } from "@/components/setup/command-line";
import { ValidationNotice } from "@/components/setup/credential-field";
import type { ValidationResult } from "@/lib/setup/types";
import type { BootEnvKey } from "@/lib/setup/boot-status";

type Presence = Record<BootEnvKey, boolean>;

async function callSetupApi<T>(
  path: string,
  token: string,
  body: unknown,
): Promise<T | { error: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-setup-token": token },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as T | { error: string } | null;
    if (json === null) return { error: `HTTP ${res.status}` };
    return json;
  } catch {
    return { error: "Couldn't reach the setup API — is the server still running?" };
  }
}

function generateEncryptionKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function BootSetupClient({
  initialPresence,
  serverless,
  prodBuild,
}: {
  initialPresence: Presence;
  serverless: boolean;
  prodBuild: boolean;
}) {
  // ── station 1: token ──
  const [token, setToken] = React.useState("");
  const [tokenUnlocked, setTokenUnlocked] = React.useState(false);
  const [unlockBusy, setUnlockBusy] = React.useState(false);
  const [unlockError, setUnlockError] = React.useState<string | null>(null);
  // Serverless hosts skip the token station entirely: the write and validate
  // routes are hard-disabled there, so this surface is read-only copy-paste
  // guidance and the token would protect nothing - while the per-process token
  // itself is unusable across a lambda fleet (each instance mints its own).
  const unlocked = serverless || tokenUnlocked;

  // ── station 2: supabase ──
  const [url, setUrl] = React.useState("");
  const [publishableKey, setPublishableKey] = React.useState("");
  const [secretKey, setSecretKey] = React.useState("");
  const [supabaseResult, setSupabaseResult] = React.useState<ValidationResult | null>(null);
  const [supabaseBusy, setSupabaseBusy] = React.useState(false);
  const supabaseAlreadySet =
    initialPresence.NEXT_PUBLIC_SUPABASE_URL &&
    initialPresence.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
    initialPresence.SUPABASE_SECRET_KEY;
  // Tri-state: only a positive rejection blocks. "unverified" (couldn't reach
  // Supabase to confirm) still enables the write, with a warning.
  const supabaseUnverified = !supabaseAlreadySet && supabaseResult?.state === "unverified";
  // Serverless: in-app validation is disabled (the values only feed the
  // copy-paste block), so filled-in fields are all the readiness there is.
  const supabaseFieldsFilled =
    url.trim().length > 0 && publishableKey.trim().length > 0 && secretKey.trim().length > 0;
  const supabaseReady =
    supabaseAlreadySet ||
    (serverless ? supabaseFieldsFilled : supabaseResult?.state === "valid" || supabaseUnverified);

  // ── station 3: encryption key ──
  const [encKey, setEncKey] = React.useState("");
  const encAlreadySet = initialPresence.SECRETS_ENCRYPTION_KEY;
  const encReady = encAlreadySet || encKey.length > 0;

  // ── station 4: write & apply ──
  const [writeBusy, setWriteBusy] = React.useState(false);
  const [writeError, setWriteError] = React.useState<string | null>(null);
  const [written, setWritten] = React.useState(false);
  const [configured, setConfigured] = React.useState(false);

  async function onUnlock() {
    const t = token.trim();
    if (!t || unlockBusy) return;
    setUnlockBusy(true);
    setUnlockError(null);
    const res = await callSetupApi<ValidationResult>("/setup/api/validate", t, { kind: "token" });
    setUnlockBusy(false);
    if ("error" in res) {
      setUnlockError(res.error);
      return;
    }
    setTokenUnlocked(true);
  }

  async function onValidateSupabase() {
    if (supabaseBusy) return;
    setSupabaseBusy(true);
    setSupabaseResult(null);
    const res = await callSetupApi<ValidationResult>("/setup/api/validate", token.trim(), {
      kind: "supabase",
      url: url.trim(),
      publishableKey: publishableKey.trim(),
      secretKey: secretKey.trim(),
    });
    setSupabaseBusy(false);
    setSupabaseResult("error" in res ? { state: "invalid", message: res.error } : res);
  }

  async function onWrite() {
    if (writeBusy) return;
    setWriteBusy(true);
    setWriteError(null);
    const values: Record<string, string> = {};
    if (!supabaseAlreadySet) {
      values.NEXT_PUBLIC_SUPABASE_URL = url.trim();
      values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = publishableKey.trim();
      values.SUPABASE_SECRET_KEY = secretKey.trim();
    }
    if (!encAlreadySet && encKey) values.SECRETS_ENCRYPTION_KEY = encKey;
    const res = await callSetupApi<{ ok: true }>("/setup/api/write", token.trim(), { values });
    setWriteBusy(false);
    if ("error" in res) {
      setWriteError(res.error);
      return;
    }
    setWritten(true);
  }

  // After the write, poll until the server actually sees the new env (next dev
  // reloads .env.local on its own; next start needs a restart — covered by the
  // card below). Also catches an operator who edited the file by hand.
  React.useEffect(() => {
    if (!written || configured) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/setup/api/status", { cache: "no-store" });
        const json = (await res.json()) as { configured?: boolean };
        if (json.configured) setConfigured(true);
      } catch {
        // Server restarting mid-poll is expected; keep trying.
      }
    }, 2_500);
    return () => clearInterval(timer);
  }, [written, configured]);

  if (configured) {
    return (
      <div className="py-16">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <div className="bg-success/10 text-success flex h-10 w-10 items-center justify-center rounded-full">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <p className="font-display text-lg font-bold tracking-tight">Instance configured</p>
              <p className="text-muted-foreground mt-1 text-sm">
                The boot configuration is live and this wizard is now locked. Sign in to finish the
                rest — runner, Redis, GitHub — from Settings → Setup.
              </p>
            </div>
            <Button asChild variant="primary" size="sm">
              <Link href="/login">
                Sign in <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="py-8">
      <div className="mb-8">
        <h1 className="font-display text-2xl font-bold tracking-tight">First-run setup</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {serverless ? (
            <>
              This DevPilot instance has no database configuration yet. This host is serverless, so
              the wizard is read-only guidance: connect a Supabase project, mint the secrets key,
              then copy the resulting block into your deployment&apos;s environment settings and
              redeploy. No value leaves this browser.
            </>
          ) : (
            <>
              This DevPilot instance has no database configuration yet. Three stations and it boots:
              unlock with the token from the server console, connect a Supabase project, and mint
              the secrets key. Everything is written to{" "}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                apps/web/.env.local
              </code>{" "}
              on this host — no value leaves it.
            </>
          )}
        </p>
      </div>

      <ol className="space-y-3">
        <StepCard
          n={1}
          done={unlocked}
          title="Unlock with the console token"
          description={
            serverless
              ? "Skipped on serverless hosts - nothing can be written or validated from this browser here, so there is nothing for the token to protect. This wizard is read-only guidance."
              : unlocked
                ? "Unlocked — this browser can now write setup values on this host."
                : "The terminal running the web server printed a one-time token at boot (it reprints on every status check). Pasting it here proves you have shell access to this machine."
          }
        >
          {!unlocked ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setUnlockError(null);
                  }}
                  placeholder="Paste the setup token"
                  spellCheck={false}
                  autoComplete="off"
                  className="flex-1 font-mono text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void onUnlock();
                    }
                  }}
                />
                <Button
                  size="sm"
                  onClick={() => void onUnlock()}
                  disabled={unlockBusy || token.trim().length === 0}
                >
                  {unlockBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LockOpen className="h-3.5 w-3.5" />
                  )}
                  Unlock
                </Button>
              </div>
              {unlockError ? <ValidationNotice state="invalid" message={unlockError} /> : null}
            </div>
          ) : null}
        </StepCard>

        <StepCard
          n={2}
          done={Boolean(supabaseReady)}
          disabled={!unlocked}
          title="Connect a Supabase project"
          description={
            supabaseAlreadySet
              ? "Already present in the environment — nothing to do here."
              : "Supabase is DevPilot's database and auth. Create a free project, then copy three values from Project settings → API keys."
          }
        >
          {!supabaseAlreadySet && unlocked ? (
            <div className="space-y-4">
              <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs leading-relaxed">
                <li>
                  Create a project at{" "}
                  <a
                    href="https://supabase.com/dashboard"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:text-foreground underline underline-offset-2"
                  >
                    supabase.com/dashboard
                  </a>{" "}
                  (or run <code className="bg-muted rounded px-1 font-mono">supabase start</code>{" "}
                  for a local stack).
                </li>
                <li>
                  Open <span className="text-foreground">Project settings → API keys</span> and copy
                  the project URL, the{" "}
                  <code className="bg-muted rounded px-1 font-mono">sb_publishable_…</code> key, and
                  the <code className="bg-muted rounded px-1 font-mono">sb_secret_…</code> key.
                </li>
                <li>
                  {serverless
                    ? "Paste all three below - they only feed the copy-paste block in the last step."
                    : "Paste all three below and validate — we ping the project live."}
                </li>
              </ol>

              <div className="space-y-3">
                <Field
                  label="Project URL"
                  value={url}
                  onChange={setUrl}
                  placeholder="https://abcdefgh.supabase.co"
                  secret={false}
                  onDirty={() => setSupabaseResult(null)}
                />
                <Field
                  label="Publishable key"
                  value={publishableKey}
                  onChange={setPublishableKey}
                  placeholder="sb_publishable_…"
                  onDirty={() => setSupabaseResult(null)}
                />
                <Field
                  label="Secret key"
                  value={secretKey}
                  onChange={setSecretKey}
                  placeholder="sb_secret_…"
                  onDirty={() => setSupabaseResult(null)}
                />
              </div>

              {!serverless ? (
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    onClick={() => void onValidateSupabase()}
                    disabled={supabaseBusy || !supabaseFieldsFilled}
                  >
                    {supabaseBusy ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Pinging project…
                      </>
                    ) : (
                      "Validate connection"
                    )}
                  </Button>
                  {supabaseResult ? (
                    <ValidationNotice
                      state={supabaseResult.state}
                      message={supabaseResult.message}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </StepCard>

        <StepCard
          n={3}
          done={encReady}
          disabled={!unlocked}
          title="Mint the secrets master key"
          description={
            encAlreadySet
              ? "Already present in the environment — nothing to do here."
              : "Every credential you add later (API keys, OAuth secrets) is encrypted at rest with this key. Generate it once and keep a copy somewhere safe — losing it makes stored secrets unrecoverable."
          }
        >
          {!encAlreadySet && unlocked ? (
            <div className="space-y-2">
              {encKey ? (
                <>
                  <CommandLine value={encKey} secret prompt="" />
                  <p className="text-warning text-[11px]">
                    Copy this into your password manager now — it is written to .env.local in the
                    next step but never shown again here.
                  </p>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEncKey(generateEncryptionKey())}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  Generate key
                </Button>
              )}
            </div>
          ) : null}
        </StepCard>

        <StepCard
          n={4}
          done={written}
          disabled={!unlocked || !supabaseReady || !encReady}
          title={serverless ? "Copy the configuration" : "Write the configuration"}
          description={
            serverless
              ? "This host is serverless — there is no writable env file. Copy the block below into your deployment's environment settings, then redeploy."
              : written
                ? (supabaseUnverified
                    ? "Saved unverified - could not reach Supabase to confirm the credentials. "
                    : "") +
                  (prodBuild
                    ? "Written. Restart the server to load it — and because browser keys are baked in at build time, rebuild first: pnpm build && pnpm --filter web start."
                    : "Written — waiting for the dev server to pick up the new environment…")
                : "Writes the values above into apps/web/.env.local (comments preserved, atomic replace). The runner reads the same file."
          }
        >
          {serverless && unlocked && supabaseReady && encReady ? (
            <div className="space-y-1.5">
              {!supabaseAlreadySet ? (
                <>
                  <CommandLine value={`NEXT_PUBLIC_SUPABASE_URL=${url.trim()}`} prompt="" />
                  <CommandLine
                    value={`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${publishableKey.trim()}`}
                    secret
                    prompt=""
                  />
                  <CommandLine value={`SUPABASE_SECRET_KEY=${secretKey.trim()}`} secret prompt="" />
                </>
              ) : null}
              {!encAlreadySet && encKey ? (
                <CommandLine value={`SECRETS_ENCRYPTION_KEY=${encKey}`} secret prompt="" />
              ) : null}
            </div>
          ) : !serverless && !written ? (
            <div className="space-y-1.5">
              {supabaseUnverified ? (
                <ValidationNotice
                  state="unverified"
                  message="Supabase couldn't be reached to confirm these credentials - they'll be saved unverified."
                />
              ) : null}
              <Button
                size="sm"
                variant="primary"
                onClick={() => void onWrite()}
                disabled={writeBusy || !unlocked || !supabaseReady || !encReady}
              >
                {writeBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Writing…
                  </>
                ) : (
                  <>
                    Write .env.local <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
              {writeError ? <ValidationNotice state="invalid" message={writeError} /> : null}
            </div>
          ) : written && !prodBuild ? (
            <div className="bg-muted/60 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <RefreshCw className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
              <span className="font-medium">Waiting for the server to reload the environment…</span>
            </div>
          ) : null}
        </StepCard>
      </ol>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret = true,
  onDirty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
  onDirty?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-muted-foreground text-xs font-medium">{label}</label>
      <Input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          onDirty?.();
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="font-mono text-xs"
      />
    </div>
  );
}
