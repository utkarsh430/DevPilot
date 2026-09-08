"use client";

// Settings → Setup wizard client. Each credential is a numbered StepCard with
// an anchor id (failure surfaces deep-link here: /settings/setup#github-oauth),
// a "where it lives" chip (env file vs encrypted instance store), and a guided
// get-one → paste → validate → save flow. Writes are operator-only; everyone
// else sees the same manifest read-only.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  Lock,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { StepCard } from "@/components/setup/step-card";
import { CommandItem, CommandLine } from "@/components/setup/command-line";
import { CredentialField, ValidationNotice } from "@/components/setup/credential-field";
import { useRunnerConnection } from "@/lib/health/use-runner-connected";
import type { SetupWizardStatus } from "@/lib/setup/wizard-status";
import type { ValidationResult } from "@/lib/setup/types";
import { LlmAuthForm } from "../llm-auth/llm-auth-form";
import { setInstanceSecretAction } from "../platform-secrets/secret-actions";
import {
  generateRunnerCredentialsAction,
  validateSetupCredentialAction,
  writeSetupEnvAction,
} from "./actions";

const INSTANCE_SAVE_NOTE = "Live everywhere within ~60s (other processes cache briefly).";

export function SetupWizardClient({ status }: { status: SetupWizardStatus }) {
  const router = useRouter();
  const op = status.operator;

  const saveEnv = React.useCallback(
    async (values: Record<string, string>) => {
      const res = await writeSetupEnvAction({ values });
      if (res.ok) {
        toast.success("Written to .env.local", {
          description: status.prodBuild
            ? "Applies after the server restarts."
            : "The dev server reloads it automatically.",
        });
        router.refresh();
        return { ok: true as const };
      }
      return { ok: false as const, error: res.error };
    },
    [router, status.prodBuild],
  );

  const saveInstance = React.useCallback(
    async (secretKey: string, value: string) => {
      const res = await setInstanceSecretAction({ secretKey, value });
      if (res.ok) {
        toast.success(`Saved ${secretKey}`, { description: INSTANCE_SAVE_NOTE });
        router.refresh();
        return { ok: true as const };
      }
      return { ok: false as const, error: res.error };
    },
    [router],
  );

  // Configured-anywhere helpers.
  const inst = (key: string) => status.instance[key] !== undefined;
  const cfg = (key: keyof SetupWizardStatus["env"]) => status.env[key] || inst(key);

  const redisDone = status.env.UPSTASH_REDIS_REST_URL && status.env.UPSTASH_REDIS_REST_TOKEN;
  const inngestDone = status.env.INNGEST_EVENT_KEY && status.env.INNGEST_SIGNING_KEY;
  const runnerKeysDone =
    status.env.DEVPILOT_RUNNER_REGISTRATION_KEY && status.env.DEVPILOT_RUNNER_TENANT_ID;
  const githubDone = cfg("GITHUB_OAUTH_CLIENT_ID") && cfg("GITHUB_OAUTH_CLIENT_SECRET");
  const langfuseDone = cfg("LANGFUSE_PUBLIC_KEY") && cfg("LANGFUSE_SECRET_KEY");
  const llmDone =
    status.llmAuthMode === "api_key" ? cfg("ANTHROPIC_API_KEY") : cfg("CLAUDE_CODE_OAUTH_TOKEN");

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <Wrench className="text-muted-foreground h-5 w-5" />
          <h1 className="font-display text-xl font-bold tracking-tight">Setup</h1>
        </div>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
          Every credential this instance runs on, in dependency order — what it&apos;s for, where to
          get one, and a live check that it works. Values marked{" "}
          <Badge tone="muted" className="mx-0.5 align-middle text-[10px]">
            env file
          </Badge>{" "}
          are written to{" "}
          <code className="bg-muted rounded px-1 font-mono text-[11px]">apps/web/.env.local</code>;
          the rest are encrypted into the platform-secrets store.
        </p>
      </header>

      {!op ? (
        <div className="border-warning/30 bg-warning/10 text-warning mb-5 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
          <Lock className="mt-px h-3.5 w-3.5 shrink-0" />
          <p>
            Read-only view — instance credentials can only be changed by an instance operator (an
            owner or admin of the first workspace on this install).
          </p>
        </div>
      ) : null}

      {!status.storeEnabled ? (
        <div className="border-warning/30 bg-warning/10 text-warning mb-5 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
          <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <p>
            The platform-secrets store is explicitly disabled (DEVPILOT_PLATFORM_SECRETS_ENABLED=0),
            so store-backed steps below can&apos;t save — manage those keys in .env.local instead,
            or remove the flag.
          </p>
        </div>
      ) : null}

      <ol className="space-y-3">
        {/* ── 1. Supabase ─────────────────────────────────────────────── */}
        <StepCard
          n={1}
          id="supabase"
          done
          title="Supabase database & auth"
          statusChip={<EnvChip />}
          description={
            <>
              Connected to{" "}
              <code className="bg-muted rounded px-1 font-mono text-[11px]">
                {status.supabaseUrl || "(unknown)"}
              </code>
              . The boot credentials only change via first-run setup or a hand edit of .env.local —
              this page never swaps the database under a live session.
            </>
          }
        />

        {/* ── 2. Encryption key ───────────────────────────────────────── */}
        <StepCard
          n={2}
          id="encryption-key"
          done={status.env.SECRETS_ENCRYPTION_KEY}
          title="Secrets master key"
          statusChip={<EnvChip />}
          description={
            status.env.SECRETS_ENCRYPTION_KEY
              ? "Present — credentials saved on this page are encrypted at rest with it."
              : "Required before any credential can be stored encrypted. Generate once; losing it makes stored secrets unrecoverable."
          }
        >
          <EncryptionKeyStep
            op={op}
            saveEnv={saveEnv}
            alreadySet={status.env.SECRETS_ENCRYPTION_KEY}
          />
        </StepCard>

        {/* ── 3. Redis ────────────────────────────────────────────────── */}
        <StepCard
          n={3}
          id="redis"
          done={redisDone}
          title="Upstash Redis (queue & locks)"
          statusChip={<EnvChip />}
          description={
            redisDone
              ? "Configured — job queue, locks, and spend counters have a home."
              : "Backs the job queue, locks, and the cost circuit breaker. Free tier is plenty for a single operator."
          }
        >
          {!redisDone ? <RedisStep op={op} saveEnv={saveEnv} /> : null}
        </StepCard>

        {/* ── 4. Inngest ──────────────────────────────────────────────── */}
        <StepCard
          n={4}
          id="inngest"
          done={inngestDone}
          title="Inngest (durable execution)"
          statusChip={<EnvChip />}
          description={
            inngestDone
              ? "Configured — agent runs are durable and resumable."
              : "Runs every agent step as a durable, resumable function. Local dev uses the Inngest dev server; these keys wire up Inngest Cloud."
          }
        >
          {!inngestDone ? <InngestStep op={op} saveEnv={saveEnv} /> : null}
        </StepCard>

        {/* ── 5. Runner ───────────────────────────────────────────────── */}
        <RunnerStep n={5} status={status} runnerKeysDone={runnerKeysDone} op={op} />

        {/* ── 6. LLM auth ─────────────────────────────────────────────── */}
        <StepCard
          n={6}
          id="llm-auth"
          done={llmDone}
          title="LLM auth"
          statusChip={<StoreChip />}
          description="How agents reach Claude: your Claude Pro/Max subscription through the local runner (default), or a per-token Anthropic API key."
        >
          <div className="space-y-5">
            <LlmAuthForm initialMode={status.llmAuthMode} />

            <div className="space-y-1.5">
              <p className="text-foreground text-sm">
                Claude Code subscription token{" "}
                <ConfiguredInline
                  configured={cfg("CLAUDE_CODE_OAUTH_TOKEN")}
                  tail={status.instance.CLAUDE_CODE_OAUTH_TOKEN}
                  env={status.env.CLAUDE_CODE_OAUTH_TOKEN}
                />
              </p>
              <p className="text-muted-foreground text-xs">
                On the machine that runs the runner, sign in once and mint a headless token — then
                paste it here so the runner survives re-logins:
              </p>
              <CommandLine value="claude setup-token" />
              <CredentialField
                label="CLAUDE_CODE_OAUTH_TOKEN"
                placeholder="sk-ant-oat…"
                disabled={!op}
                validate={(v) => runValidate({ kind: "claude_token", value: v })}
                onSave={(v) => saveInstance("CLAUDE_CODE_OAUTH_TOKEN", v)}
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-foreground text-sm">
                Anthropic API key{" "}
                <ConfiguredInline
                  configured={cfg("ANTHROPIC_API_KEY")}
                  tail={status.instance.ANTHROPIC_API_KEY}
                  env={status.env.ANTHROPIC_API_KEY}
                />
              </p>
              <p className="text-muted-foreground text-xs">
                Only needed for API-key mode (or the paid LLM health ping). Create one at{" "}
                <GuideLink href="https://console.anthropic.com">console.anthropic.com</GuideLink>.
              </p>
              <CredentialField
                label="ANTHROPIC_API_KEY"
                placeholder="sk-ant-api…"
                disabled={!op}
                validate={(v) => runValidate({ kind: "anthropic", value: v })}
                onSave={(v) => saveInstance("ANTHROPIC_API_KEY", v)}
              />
            </div>
          </div>
        </StepCard>

        {/* ── 7. GitHub OAuth ─────────────────────────────────────────── */}
        <StepCard
          n={7}
          id="github-oauth"
          done={githubDone}
          title="GitHub OAuth app"
          statusChip={<StoreChip />}
          description={
            githubDone
              ? "Configured — sign-in with GitHub and token refresh both work."
              : "Powers “Continue with GitHub” and keeps repo tokens fresh. One OAuth app, pasted in two places: your Supabase dashboard and here."
          }
        >
          <GithubOauthStep status={status} op={op} saveInstance={saveInstance} />
        </StepCard>

        {/* ── 8. Langfuse ─────────────────────────────────────────────── */}
        <StepCard
          n={8}
          id="langfuse"
          done={langfuseDone}
          optional
          title="Langfuse (tracing)"
          statusChip={<StoreChip />}
          description={
            langfuseDone
              ? "Configured — every run/step/LLM call lands as a trace."
              : "The trace is the product: run timelines, token counts, and deep links from the Run Inspector. Free tier at cloud.langfuse.com."
          }
        >
          <LangfuseStep op={op} saveInstance={saveInstance} />
        </StepCard>

        {/* ── 9. Stripe ───────────────────────────────────────────────── */}
        <StepCard
          n={9}
          id="stripe"
          done={status.env.STRIPE_SECRET_KEY}
          optional
          title="Stripe (billing)"
          statusChip={<EnvChip />}
          description={
            status.env.STRIPE_SECRET_KEY
              ? "Configured — usage metering and the billing page are live."
              : "Only needed to charge tenants for usage. Without it, billing surfaces stay dormant — everything else runs."
          }
        >
          <div className="space-y-4">
            <CredentialField
              label="STRIPE_SECRET_KEY"
              placeholder="sk_live_… or sk_test_…"
              disabled={!op}
              configuredHint={
                status.env.STRIPE_SECRET_KEY ? "Currently set in .env.local" : undefined
              }
              validate={(v) => runValidate({ kind: "stripe", value: v })}
              onSave={(v) => saveEnv({ STRIPE_SECRET_KEY: v })}
            />
            <CredentialField
              label="STRIPE_WEBHOOK_SECRET"
              placeholder="whsec_…"
              disabled={!op}
              configuredHint={
                status.env.STRIPE_WEBHOOK_SECRET ? "Currently set in .env.local" : undefined
              }
              saveLabel="Save"
              onSave={(v) => saveEnv({ STRIPE_WEBHOOK_SECRET: v })}
            />
          </div>
        </StepCard>
      </ol>
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────

async function runValidate(
  input: Parameters<typeof validateSetupCredentialAction>[0],
): Promise<ValidationResult> {
  const res = await validateSetupCredentialAction(input);
  if (!res.ok) return { state: "invalid", message: res.error };
  return res.value;
}

function EnvChip() {
  return <Badge tone="muted">env file</Badge>;
}

function StoreChip() {
  return <Badge tone="muted">instance store</Badge>;
}

function ConfiguredInline({
  configured,
  tail,
  env,
}: {
  configured: boolean;
  tail?: string | null;
  env: boolean;
}) {
  if (!configured) return null;
  return (
    <Badge tone="ok" className="ml-1 align-middle text-[10px]">
      {env ? "set in env" : `instance ••••${tail ?? ""}`}
    </Badge>
  );
}

function GuideLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="hover:text-foreground inline-flex items-center gap-0.5 underline underline-offset-2"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

type SaveEnv = (values: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
type SaveInstance = (key: string, value: string) => Promise<{ ok: boolean; error?: string }>;

function FieldRow({
  label,
  value,
  onChange,
  placeholder,
  secret = true,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-muted-foreground text-xs font-medium">{label}</label>
      <Input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        className="font-mono text-xs"
      />
    </div>
  );
}

/** Multi-field validate-then-save runner shared by the pair-credential steps. */
function usePairSave() {
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ValidationResult | null>(null);

  async function run(
    validate: () => Promise<ValidationResult>,
    save: () => Promise<{ ok: boolean; error?: string }>,
  ) {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const check = await validate();
      setResult(check);
      if (check.state === "invalid") return;
      const res = await save();
      if (!res.ok) {
        setResult({ state: "invalid", message: res.error ?? "Save failed" });
        return;
      }
      setResult({
        state: check.state,
        message:
          check.state === "unverified"
            ? `Saved — but ${check.message}`
            : `${check.message} — saved`,
      });
    } catch {
      setResult({
        state: "invalid",
        message: "Couldn't reach the server - check that it's running and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return { busy, result, run, setResult };
}

// ── step bodies ──────────────────────────────────────────────────────────────

function EncryptionKeyStep({
  op,
  saveEnv,
  alreadySet,
}: {
  op: boolean;
  saveEnv: SaveEnv;
  alreadySet: boolean;
}) {
  // The generated key must SURVIVE the post-save refresh (this component stays
  // mounted; only the parent's done-state flips) — it's the operator's one
  // chance to copy it into a password manager.
  const [generated, setGenerated] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onGenerate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const key = btoa(bin);
    try {
      const res = await saveEnv({ SECRETS_ENCRYPTION_KEY: key });
      if (!res.ok) {
        setError(res.error ?? "Write failed");
        return;
      }
      setGenerated(key);
    } catch {
      setError("Couldn't reach the server - check that it's running and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (alreadySet && !generated) return null;

  return (
    <div className="space-y-2">
      {generated ? (
        <>
          <CommandLine value={generated} secret prompt="" />
          <p className="text-warning text-[11px]">
            Copy this into your password manager now — it&apos;s in .env.local but never shown here
            again. Losing it makes every stored secret unrecoverable.
          </p>
        </>
      ) : (
        <Button
          size="sm"
          variant="primary"
          onClick={() => void onGenerate()}
          disabled={!op || busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <KeyRound className="h-3.5 w-3.5" />
          )}
          Generate & save key
        </Button>
      )}
      {error ? <ValidationNotice state="invalid" message={error} /> : null}
    </div>
  );
}

function RedisStep({ op, saveEnv }: { op: boolean; saveEnv: SaveEnv }) {
  const [url, setUrl] = React.useState("");
  const [token, setToken] = React.useState("");
  const { busy, result, run } = usePairSave();

  return (
    <div className="space-y-4">
      <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs leading-relaxed">
        <li>
          Create a free Redis database at{" "}
          <GuideLink href="https://console.upstash.com">console.upstash.com</GuideLink>.
        </li>
        <li>
          On the database page, open the <span className="text-foreground">REST API</span> section
          and copy <code className="bg-muted rounded px-1 font-mono">UPSTASH_REDIS_REST_URL</code>{" "}
          and <code className="bg-muted rounded px-1 font-mono">UPSTASH_REDIS_REST_TOKEN</code>.
        </li>
        <li>Paste both below — we PING it live before saving.</li>
      </ol>
      <div className="space-y-3">
        <FieldRow
          label="REST URL"
          value={url}
          onChange={setUrl}
          placeholder="https://your-db.upstash.io"
          secret={false}
          disabled={!op}
        />
        <FieldRow
          label="REST token"
          value={token}
          onChange={setToken}
          placeholder="AX…"
          disabled={!op}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!op || busy || !url.trim() || !token.trim()}
          onClick={() =>
            void run(
              () => runValidate({ kind: "redis", url: url.trim(), token: token.trim() }),
              () =>
                saveEnv({
                  UPSTASH_REDIS_REST_URL: url.trim(),
                  UPSTASH_REDIS_REST_TOKEN: token.trim(),
                }),
            )
          }
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Pinging…
            </>
          ) : (
            "Validate & save"
          )}
        </Button>
        {result ? <ValidationNotice state={result.state} message={result.message} /> : null}
      </div>
    </div>
  );
}

function InngestStep({ op, saveEnv }: { op: boolean; saveEnv: SaveEnv }) {
  const [eventKey, setEventKey] = React.useState("");
  const [signingKey, setSigningKey] = React.useState("");
  const { busy, result, run } = usePairSave();

  return (
    <div className="space-y-4">
      <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs leading-relaxed">
        <li>
          Local dev? Run{" "}
          <code className="bg-muted rounded px-1 font-mono">pnpm --filter web dev:inngest</code>{" "}
          instead — no keys needed.
        </li>
        <li>
          For Inngest Cloud, create an app at{" "}
          <GuideLink href="https://app.inngest.com">app.inngest.com</GuideLink> and copy an{" "}
          <span className="text-foreground">event key</span> plus the{" "}
          <span className="text-foreground">signing key</span> from its settings.
        </li>
      </ol>
      <div className="space-y-3">
        <FieldRow
          label="INNGEST_EVENT_KEY"
          value={eventKey}
          onChange={setEventKey}
          disabled={!op}
        />
        <FieldRow
          label="INNGEST_SIGNING_KEY"
          value={signingKey}
          onChange={setSigningKey}
          placeholder="signkey-…"
          disabled={!op}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!op || busy || !eventKey.trim() || !signingKey.trim()}
          onClick={() =>
            void run(
              () =>
                runValidate({
                  kind: "inngest",
                  eventKey: eventKey.trim(),
                  signingKey: signingKey.trim(),
                }),
              () =>
                saveEnv({
                  INNGEST_EVENT_KEY: eventKey.trim(),
                  INNGEST_SIGNING_KEY: signingKey.trim(),
                }),
            )
          }
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking…
            </>
          ) : (
            "Validate & save"
          )}
        </Button>
        {result ? <ValidationNotice state={result.state} message={result.message} /> : null}
      </div>
    </div>
  );
}

function RunnerStep({
  n,
  status,
  runnerKeysDone,
  op,
}: {
  n: number;
  status: SetupWizardStatus;
  runnerKeysDone: boolean;
  op: boolean;
}) {
  const router = useRouter();
  const { status: connection, runner } = useRunnerConnection(status.health);
  const connected = connection === "connected";
  const [generatedKey, setGeneratedKey] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const notNeeded = status.llmAuthMode === "api_key";

  async function onGenerate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await generateRunnerCredentialsAction();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setGeneratedKey(res.value.registrationKey);
      toast.success("Runner credentials written to .env.local");
      router.refresh();
    } catch {
      setError("Couldn't reach the server - check that it's running and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      n={n}
      id="runner"
      done={notNeeded || (runnerKeysDone && connected)}
      status={
        notNeeded || (runnerKeysDone && connected) ? "done" : runnerKeysDone ? "attention" : "todo"
      }
      title="Local runner"
      statusChip={<EnvChip />}
      description={
        notNeeded
          ? "Not required — this tenant runs on the API runner (see LLM auth below)."
          : connected
            ? "A runner is online and heartbeating — dispatched tickets will run."
            : runnerKeysDone
              ? "Handshake keys are in place — start the worker and it appears here."
              : "Agents execute on a runner you host (your machine or an always-on box). It authenticates to the engine with a registration key bound to this workspace."
      }
    >
      {!notNeeded ? (
        <div className="space-y-4">
          {!runnerKeysDone ? (
            <div className="space-y-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => void onGenerate()}
                disabled={!op || busy}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <KeyRound className="h-3.5 w-3.5" />
                )}
                Generate runner credentials
              </Button>
              <p className="text-muted-foreground text-[11px]">
                Writes a fresh{" "}
                <code className="bg-muted rounded px-1 font-mono">
                  DEVPILOT_RUNNER_REGISTRATION_KEY
                </code>{" "}
                and this workspace&apos;s{" "}
                <code className="bg-muted rounded px-1 font-mono">DEVPILOT_RUNNER_TENANT_ID</code>{" "}
                to .env.local — the runner reads the same file.
              </p>
              {error ? <ValidationNotice state="invalid" message={error} /> : null}
            </div>
          ) : null}

          {generatedKey ? (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-[11px]">
                Registration key (for configuring a REMOTE runner host — already saved locally):
              </p>
              <CommandLine value={generatedKey} secret prompt="" />
            </div>
          ) : null}

          {runnerKeysDone || generatedKey ? (
            <ol className="space-y-3">
              <CommandItem
                n={1}
                label="Install the Claude CLI and sign in with your Pro/Max subscription."
                hint="Use claude setup-token instead of login on a headless host."
                commands={["npm install -g @anthropic-ai/claude-code", "claude login"]}
              />
              <CommandItem
                n={2}
                label="Start the runner worker from the repo root."
                hint="Reads its config from apps/web/.env.local — no env file of its own."
                commands={["pnpm --filter @devpilot/runner dev"]}
              />
            </ol>
          ) : null}

          <RunnerLiveIndicator
            connection={connection}
            detail={runner?.detail ?? null}
            waitingExpected={runnerKeysDone || Boolean(generatedKey)}
          />
        </div>
      ) : null}
    </StepCard>
  );
}

function RunnerLiveIndicator({
  connection,
  detail,
  waitingExpected,
}: {
  connection: "checking" | "connected" | "disconnected";
  detail: string | null;
  waitingExpected: boolean;
}) {
  if (connection === "connected") {
    return (
      <div className="border-success/40 bg-success/10 text-success flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Check className="h-4 w-4 shrink-0" />
        <span className="font-medium">Runner connected</span>
        {detail ? <span className="text-success/80 ml-auto text-[11px]">{detail}</span> : null}
      </div>
    );
  }
  if (!waitingExpected) return null;
  const checking = connection === "checking";
  return (
    <div className="bg-muted/60 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
      {checking ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      ) : (
        <span className="relative inline-flex h-2.5 w-2.5 shrink-0" aria-hidden>
          <span className="bg-warning absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
          <span className="bg-warning relative inline-flex h-2.5 w-2.5 rounded-full" />
        </span>
      )}
      <span className="font-medium">
        {checking ? "Checking for your runner…" : "Waiting for your runner…"}
      </span>
    </div>
  );
}

function GithubOauthStep({
  status,
  op,
  saveInstance,
}: {
  status: SetupWizardStatus;
  op: boolean;
  saveInstance: SaveInstance;
}) {
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const { busy, result, run } = usePairSave();

  const callbackUrl = status.supabaseUrl
    ? `${status.supabaseUrl.replace(/\/+$/, "")}/auth/v1/callback`
    : "https://<project-ref>.supabase.co/auth/v1/callback";
  // Read after mount — window isn't available during SSR and a render-time
  // branch on it is a hydration mismatch.
  const [appUrl, setAppUrl] = React.useState("");
  React.useEffect(() => setAppUrl(window.location.origin), []);

  return (
    <div className="space-y-4">
      <ol className="text-muted-foreground list-decimal space-y-1.5 pl-5 text-xs leading-relaxed">
        <li>
          Open{" "}
          <GuideLink href="https://github.com/settings/developers">
            github.com/settings/developers
          </GuideLink>{" "}
          → <span className="text-foreground">New OAuth App</span>.
        </li>
        <li>
          Name it anything (e.g. “DevPilot”), set the homepage to{" "}
          <code className="bg-muted rounded px-1 font-mono">{appUrl || "your app URL"}</code>, and
          set the <span className="text-foreground">Authorization callback URL</span> to exactly:
        </li>
      </ol>
      <CommandLine value={callbackUrl} prompt="" />
      <ol
        start={3}
        className="text-muted-foreground list-decimal space-y-1.5 pl-5 text-xs leading-relaxed"
      >
        <li>
          Register, then generate a <span className="text-foreground">client secret</span>. Copy the
          client ID + secret.
        </li>
        <li>
          In your Supabase dashboard, open{" "}
          <span className="text-foreground">Authentication → Sign in / Providers → GitHub</span>,
          enable it, and paste the SAME id + secret there. (Supabase performs the sign-in handshake;
          DevPilot uses the pair below for token refresh.)
        </li>
        <li>Paste the pair here — we verify it against GitHub without a real sign-in.</li>
      </ol>
      <div className="space-y-3">
        <FieldRow
          label="GITHUB_OAUTH_CLIENT_ID"
          value={clientId}
          onChange={setClientId}
          placeholder="Iv1.… or Ov23li…"
          secret={false}
          disabled={!op}
        />
        <FieldRow
          label="GITHUB_OAUTH_CLIENT_SECRET"
          value={clientSecret}
          onChange={setClientSecret}
          disabled={!op}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!op || busy || !clientId.trim() || !clientSecret.trim()}
          onClick={() =>
            void run(
              () =>
                runValidate({
                  kind: "github",
                  clientId: clientId.trim(),
                  clientSecret: clientSecret.trim(),
                }),
              async () => {
                const a = await saveInstance("GITHUB_OAUTH_CLIENT_ID", clientId.trim());
                if (!a.ok) return a;
                return saveInstance("GITHUB_OAUTH_CLIENT_SECRET", clientSecret.trim());
              },
            )
          }
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Verifying…
            </>
          ) : (
            "Validate & save"
          )}
        </Button>
        {result ? <ValidationNotice state={result.state} message={result.message} /> : null}
      </div>
    </div>
  );
}

function LangfuseStep({ op, saveInstance }: { op: boolean; saveInstance: SaveInstance }) {
  const [publicKey, setPublicKey] = React.useState("");
  const [secretKey, setSecretKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const { busy, result, run } = usePairSave();

  return (
    <div className="space-y-4">
      <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs leading-relaxed">
        <li>
          Create a project at{" "}
          <GuideLink href="https://cloud.langfuse.com">cloud.langfuse.com</GuideLink> (US region;
          use cloud.langfuse.com/eu for EU).
        </li>
        <li>
          In project settings → <span className="text-foreground">API keys</span>, create a key pair
          (<code className="bg-muted rounded px-1 font-mono">pk-lf-…</code> /{" "}
          <code className="bg-muted rounded px-1 font-mono">sk-lf-…</code>).
        </li>
      </ol>
      <div className="space-y-3">
        <FieldRow
          label="LANGFUSE_PUBLIC_KEY"
          value={publicKey}
          onChange={setPublicKey}
          placeholder="pk-lf-…"
          secret={false}
          disabled={!op}
        />
        <FieldRow
          label="LANGFUSE_SECRET_KEY"
          value={secretKey}
          onChange={setSecretKey}
          placeholder="sk-lf-…"
          disabled={!op}
        />
        <FieldRow
          label="Region URL (optional — blank = US)"
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder="https://us.cloud.langfuse.com"
          secret={false}
          disabled={!op}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!op || busy || !publicKey.trim() || !secretKey.trim()}
          onClick={() =>
            void run(
              () =>
                runValidate({
                  kind: "langfuse",
                  publicKey: publicKey.trim(),
                  secretKey: secretKey.trim(),
                  baseUrl: baseUrl.trim() || undefined,
                }),
              async () => {
                const a = await saveInstance("LANGFUSE_PUBLIC_KEY", publicKey.trim());
                if (!a.ok) return a;
                const b = await saveInstance("LANGFUSE_SECRET_KEY", secretKey.trim());
                if (!b.ok) return b;
                if (baseUrl.trim()) return saveInstance("LANGFUSE_BASE_URL", baseUrl.trim());
                return { ok: true };
              },
            )
          }
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking…
            </>
          ) : (
            "Validate & save"
          )}
        </Button>
        {result ? <ValidationNotice state={result.state} message={result.message} /> : null}
      </div>
      <p className="text-muted-foreground flex items-center gap-1 text-[11px]">
        <ArrowRight className="h-3 w-3" />
        The system-health Langfuse probe turns green once these resolve — no env entry needed.
      </p>
    </div>
  );
}
