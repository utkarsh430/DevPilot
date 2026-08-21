"use client";

// M5 — JD-to-role synthesizer (client UI).
//
// Layout: split — left column holds the JD textarea + tips + samples
// dropdown, right column holds the synthesized draft editor. Stacks on
// mobile. On save we route the operator forward through toast + CTAs so the
// next step is obvious.
//
// The action signatures (synthesizeRoleAction / createCustomRoleAction) are
// preserved exactly; this file only changes the presentation.

import * as React from "react";
import Link from "next/link";
import {
  Sparkles,
  FileText,
  ChevronDown,
  Wand2,
  CheckCircle2,
  Lightbulb,
  Pencil,
  Hash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { createCustomRoleAction, synthesizeRoleAction, type SynthesizedRole } from "./actions";

type Status =
  | { kind: "idle" }
  | { kind: "synthesizing" }
  | { kind: "draft"; draft: SynthesizedRole }
  | { kind: "saving"; draft: SynthesizedRole }
  | { kind: "saved"; slug: string; agentId: string }
  | { kind: "error"; message: string };

// Sample JDs. Each is short enough to land inside the textarea but long
// enough (>= 50 chars) to clear the action's input gate.
type Sample = { id: string; label: string; description: string; text: string };

const SAMPLES: Sample[] = [
  {
    id: "loc",
    label: "Localization Reviewer",
    description: "Audits UI strings for translation quality.",
    text: `Localization Reviewer

We're looking for a senior localization reviewer to audit our UI string changes
for translation quality, cultural appropriateness, and consistency with our
glossary. You'll review pull requests that change English source strings, flag
strings that won't translate well (idioms, contractions, hard-coded plurals),
and recommend wording that's easier for translators downstream.

You're comfortable reading React/TS source to find the string usage sites and
understand the surrounding UI context.`,
  },
  {
    id: "code-review",
    label: "Code Reviewer",
    description: "Reviews diffs for correctness + style.",
    text: `Senior Code Reviewer

You review incoming pull requests for correctness, security, performance, and
adherence to our style guide. For each PR you produce a verdict (approve /
request changes / block) and an itemised list of comments with file + line
references. You read the surrounding code to understand intent before
commenting; you avoid nitpicking style the autoformatter already handles.`,
  },
  {
    id: "compliance",
    label: "Compliance Checker",
    description: "Verifies tickets against policy.",
    text: `Compliance Checker

You verify that every change shipping to production complies with our SOC2
control set: data-handling, logging, retention, and access changes are
disclosed and approved. For each ticket you receive, identify which controls
apply, check that the artefacts (migrations, env changes, runbook updates)
exist, and produce a pass/fail verdict with the specific control IDs.`,
  },
  {
    id: "release-notes",
    label: "Release Notes Writer",
    description: "Turns merged tickets into user-facing notes.",
    text: `Release Notes Writer

You turn a batch of merged tickets into customer-facing release notes. You
group by theme (new, improved, fixed), rewrite engineering-speak into clear
user-facing language, and call out breaking changes prominently. You keep the
voice consistent with our product brand and never invent features that weren't
actually shipped.`,
  },
  {
    id: "incident",
    label: "Incident Responder",
    description: "Triages alerts and drafts comms.",
    text: `Incident Responder

When a production alert fires you collect signal from logs and metrics, write
a short situation summary, propose an initial mitigation, and draft customer +
internal status updates. You distinguish a degraded subsystem from a full
outage and recommend the right comms channel for each. You never claim
resolution until verification evidence is attached to the ticket.`,
  },
];

const DEFAULT_SAMPLE_TEXT = SAMPLES[0]?.text ?? "";

export function SynthForm() {
  const [jd, setJd] = React.useState(DEFAULT_SAMPLE_TEXT);
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });

  async function onSynthesize() {
    setStatus({ kind: "synthesizing" });
    const res = await synthesizeRoleAction(jd);
    if (!res.ok) {
      toast.error("Synthesis failed", { description: res.error });
      setStatus({ kind: "error", message: res.error });
      return;
    }
    toast.success("Draft ready", {
      description: "Review and edit before saving.",
    });
    setStatus({ kind: "draft", draft: res.draft });
  }

  async function onSave(draft: SynthesizedRole) {
    setStatus({ kind: "saving", draft });
    const res = await createCustomRoleAction(draft);
    if (!res.ok) {
      toast.error("Couldn't save role", { description: res.error });
      setStatus({ kind: "error", message: res.error });
      return;
    }
    toast.success(`Role "${res.slug}" saved`, {
      description: "Dispatchable as soon as a ticket requests this slug.",
    });
    setStatus({ kind: "saved", slug: res.slug, agentId: res.agentId });
  }

  function loadSample(s: Sample) {
    setJd(s.text);
    setStatus({ kind: "idle" });
  }

  const draftVisible = status.kind === "draft" || status.kind === "saving";

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* ─── Left: JD input ───────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <FileText className="text-muted-foreground h-4 w-4" />
                Job description
              </CardTitle>
              <CardDescription className="mt-1 text-xs">
                Paste a job description. We&apos;ll synthesize a draft role on the right.
              </CardDescription>
            </div>
            <SamplesDropdown onPick={loadSample} />
          </CardHeader>
          <CardContent className="pt-0">
            <Textarea
              id="jd"
              rows={14}
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              className="font-sans text-sm"
              placeholder="Paste a JD here…"
              aria-label="Job description"
            />
            <div className="text-muted-foreground mt-2 flex items-center justify-between text-[11px]">
              <span>Minimum 50 characters, maximum 6,000.</span>
              <CharCount value={jd} min={50} max={6_000} />
            </div>
          </CardContent>
          <CardFooter className="justify-between border-t pt-4">
            <span className="text-muted-foreground text-xs">
              Sonnet generates the draft. You stay in control.
            </span>
            <Button
              variant="primary"
              onClick={onSynthesize}
              disabled={status.kind === "synthesizing" || jd.trim().length < 50}
              className="gap-2"
            >
              <Wand2 className="h-4 w-4" />
              {status.kind === "synthesizing" ? "Synthesizing…" : "Synthesize role"}
            </Button>
          </CardFooter>
        </Card>

        <TipsCard />
      </div>

      {/* ─── Right: synthesized draft ──────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        {status.kind === "idle" && <DraftPlaceholder />}
        {status.kind === "synthesizing" && <DraftLoading />}
        {status.kind === "error" && <ErrorCard message={status.message} />}
        {draftVisible && (
          <DraftEditor
            draft={(status as { draft: SynthesizedRole }).draft}
            saving={status.kind === "saving"}
            onSave={onSave}
            onChange={(next) => setStatus({ kind: "draft", draft: next })}
          />
        )}
        {status.kind === "saved" && <SavedCard slug={status.slug} agentId={status.agentId} />}
      </div>
    </div>
  );
}

// ---------- sub-components -------------------------------------------------

function SamplesDropdown({ onPick }: { onPick: (s: Sample) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Sparkles className="h-3.5 w-3.5" />
          Examples
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Inject a sample JD</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SAMPLES.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => onPick(s)}
            className="flex-col items-start gap-1 py-2.5"
          >
            <span className="text-sm font-medium leading-none">{s.label}</span>
            <span className="text-muted-foreground text-xs leading-snug">{s.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CharCount({ value, min, max }: { value: string; min: number; max: number }) {
  const len = value.length;
  const tooShort = len < min;
  const tooLong = len > max;
  return (
    <span
      className={cn(
        "tabular-nums",
        tooShort && "text-muted-foreground",
        tooLong && "text-destructive",
        !tooShort && !tooLong && "text-success",
      )}
    >
      {len.toLocaleString()} / {max.toLocaleString()}
    </span>
  );
}

function TipsCard() {
  return (
    <Card className="bg-muted/30 border-dashed">
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground flex items-center gap-2 text-xs uppercase tracking-wide">
          <Lightbulb className="h-3.5 w-3.5" />
          Tips for a better draft
        </CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground space-y-1.5 text-xs">
        <p>
          <span className="text-foreground">State the inputs.</span> What does the role read —
          diffs, tickets, logs, designs?
        </p>
        <p>
          <span className="text-foreground">State the output.</span> A verdict? A draft? A revised
          file? Be explicit.
        </p>
        <p>
          <span className="text-foreground">Name the guardrails.</span> Anything the role must never
          do (e.g. ship without tests).
        </p>
        <p>
          <span className="text-foreground">Cognitive load.</span> Deep reasoning roles use Opus;
          classification roles use Haiku.
        </p>
      </CardContent>
    </Card>
  );
}

function DraftPlaceholder() {
  return (
    <Card className="bg-muted/20 flex h-full flex-col items-center justify-center border-dashed px-6 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex h-12 w-12 items-center justify-center rounded-full">
        <Wand2 className="h-5 w-5" />
      </div>
      <p className="mt-3 text-sm font-medium">Your draft will appear here</p>
      <p className="text-muted-foreground mt-1 max-w-sm text-xs">
        Paste a JD on the left (or pick an example) and click{" "}
        <span className="text-foreground">Synthesize role</span>. We generate a complete role config
        you can edit before saving.
      </p>
    </Card>
  );
}

function DraftLoading() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Synthesizing draft…</CardTitle>
        <CardDescription className="text-xs">
          Sonnet is reading your JD and producing a system prompt + config.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="bg-muted h-4 animate-pulse rounded" />
        <div className="bg-muted h-4 w-5/6 animate-pulse rounded" />
        <div className="bg-muted h-24 animate-pulse rounded" />
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-muted h-8 animate-pulse rounded" />
          <div className="bg-muted h-8 animate-pulse rounded" />
          <div className="bg-muted h-8 animate-pulse rounded" />
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader>
        <CardTitle className="text-destructive text-sm">Something went wrong</CardTitle>
        <CardDescription className="text-destructive/80 text-xs">{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

const SLUG_REGEX = /^[a-z][a-z0-9_]{1,30}$/;

function DraftEditor({
  draft,
  saving,
  onChange,
  onSave,
}: {
  draft: SynthesizedRole;
  saving: boolean;
  onChange: (next: SynthesizedRole) => void;
  onSave: (draft: SynthesizedRole) => void;
}) {
  const slugValid = SLUG_REGEX.test(draft.slug);
  const displayNameValid =
    draft.displayName.trim().length >= 2 && draft.displayName.trim().length <= 60;
  const systemPromptValid = draft.systemPrompt.length >= 120 && draft.systemPrompt.length <= 8_000;
  const canSave = slugValid && displayNameValid && systemPromptValid && !saving;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Pencil className="text-muted-foreground h-4 w-4" />
            Synthesized draft
          </CardTitle>
          <CardDescription className="mt-1 text-xs">
            Edit anything. Required fields must be filled before saving.
          </CardDescription>
        </div>
        <Badge tone="info" className="gap-1">
          <Sparkles className="h-3 w-3" />
          AI-generated
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4">
        <Field
          label="Slug"
          hint="snake_case identifier, 2–31 chars, starting with a letter"
          invalid={!slugValid}
        >
          <div className="relative">
            <Hash className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              value={draft.slug}
              onChange={(e) => onChange({ ...draft, slug: e.target.value })}
              className="pl-8 font-mono text-sm"
              aria-invalid={!slugValid}
              aria-label="Role slug"
            />
          </div>
        </Field>

        <Field
          label="Display name"
          hint="Shown in comments and the Run Inspector"
          invalid={!displayNameValid}
        >
          <Input
            value={draft.displayName}
            onChange={(e) => onChange({ ...draft, displayName: e.target.value })}
            aria-invalid={!displayNameValid}
            aria-label="Display name"
          />
        </Field>

        <Field
          label="System prompt"
          hint="The full prompt the role runs with"
          invalid={!systemPromptValid}
          rightSlot={<CharCount value={draft.systemPrompt} min={120} max={8_000} />}
        >
          <Textarea
            rows={12}
            value={draft.systemPrompt}
            onChange={(e) => onChange({ ...draft, systemPrompt: e.target.value })}
            className="font-mono text-xs leading-relaxed"
            aria-invalid={!systemPromptValid}
            aria-label="System prompt"
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Model tier">
            <Select
              value={draft.modelTier}
              onChange={(v) => onChange({ ...draft, modelTier: v as SynthesizedRole["modelTier"] })}
              ariaLabel="Model tier"
              options={[
                { value: "default", label: "default · Sonnet" },
                { value: "heavy", label: "heavy · Opus" },
                { value: "cheap", label: "cheap · Haiku" },
              ]}
            />
          </Field>
          <Field label="Runner">
            <Select
              value={draft.runnerPolicy}
              onChange={(v) =>
                onChange({
                  ...draft,
                  runnerPolicy: v as SynthesizedRole["runnerPolicy"],
                })
              }
              ariaLabel="Runner policy"
              options={[
                { value: "local-cc", label: "local-cc · default (Claude Code, tools)" },
                { value: "api", label: "api · per-token (multi-tenant only)" },
              ]}
            />
          </Field>
          <Field label="On success">
            <Select
              value={draft.onSuccessStatus}
              onChange={(v) =>
                onChange({
                  ...draft,
                  onSuccessStatus: v as SynthesizedRole["onSuccessStatus"],
                })
              }
              ariaLabel="On success status"
              options={[
                { value: "in_review", label: "in_review · downstream reviewer" },
                { value: "done", label: "done · terminal" },
                { value: "ready", label: "ready · re-queue next role" },
              ]}
            />
          </Field>
        </div>
      </CardContent>

      <CardFooter className="justify-between border-t pt-4">
        <span className="text-muted-foreground text-xs">
          Dispatchable via{" "}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">
            tickets.requested_role
          </code>
          .
        </span>
        <Button
          variant="primary"
          onClick={() => onSave(draft)}
          disabled={!canSave}
          title={canSave ? "Save this role to your tenant" : "Fix invalid fields first"}
        >
          {saving ? "Saving…" : "Save role"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function SavedCard({ slug, agentId }: { slug: string; agentId: string }) {
  return (
    <Card className="border-success/40 bg-success/5">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="text-success h-5 w-5" />
          <CardTitle className="text-sm">Role saved</CardTitle>
        </div>
        <CardDescription className="text-xs">
          Saved as <code className="bg-background/60 rounded px-1 py-0.5 font-mono">{slug}</code>{" "}
          (agent{" "}
          <code className="bg-background/60 rounded px-1 py-0.5 font-mono">
            {agentId.slice(0, 8)}
          </code>
          ). File a ticket with{" "}
          <code className="bg-background/60 rounded px-1 py-0.5 font-mono">
            requested_role: &quot;{slug}&quot;
          </code>{" "}
          to dispatch it.
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex flex-wrap gap-2 border-t pt-4">
        <Button asChild variant="primary" size="sm">
          <Link href="/board">File a test ticket</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/builder">Open builder</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/agents">View roles</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

// Generic labeled field wrapper. `rightSlot` lets a row (like the char count)
// align next to the label.
function Field({
  label,
  hint,
  children,
  invalid,
  rightSlot,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  invalid?: boolean;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          {label}
        </label>
        {rightSlot && <span className="text-[10px]">{rightSlot}</span>}
      </div>
      {children}
      {hint && (
        <p
          className={cn("mt-1 text-[11px]", invalid ? "text-destructive" : "text-muted-foreground")}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

// Native <select> styled to match the rest of the form. We avoid a Radix
// Select primitive here — none ships in components/ui yet, and adding one is
// out of scope for this UI polish pass.
function Select({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={cn(
          "border-input flex h-9 w-full appearance-none rounded-md border bg-transparent px-3 pr-8 text-sm shadow-sm transition-colors",
          "focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
      />
    </div>
  );
}
