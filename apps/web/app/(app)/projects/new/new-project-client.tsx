"use client";

// Phase 2 / M5a–M5b — Create-project form.
//
// Tabs:
//   - "Connect existing" — paste a github.com URL, auto-derive a project name
//     from the URL, hit the server action which validates via GET /repos/...
//   - "Create new" — name + prose description + private toggle, hit the
//     server action which creates the repo on GitHub, inserts the project row,
//     files a project_scaffolder ticket, and emits the dispatch event so the
//     runner picks the scaffolder up immediately.
//
// Pattern matches `agents/new/synth-form.tsx` — useState + server action +
// toast (success/error) + router.push on success.

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  FileUp,
  FolderGit2,
  Github,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  Sparkles,
  Unlock,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { TierPicker } from "@/components/team-tiers/TierPicker";
import { StackTagPicker } from "@/components/stack/StackTagPicker";
import {
  EMPTY_LLM_DRAFT,
  LlmProviderFields,
  llmDraftToInput,
  type LlmDraft,
} from "@/components/llm/LlmProviderFields";
import { DEFAULT_TEAM_TIER, type TeamTier } from "@/lib/team-tiers/tiers";
import { PlatformPicker } from "@/components/projects/PlatformPicker";
import { DEFAULT_PROJECT_TYPE, type ProjectType } from "@/lib/projects/project-type";
import { EcosystemPicker } from "@/components/stack/EcosystemPicker";
import { DEFAULT_ECOSYSTEM, type EcosystemChoice } from "@/lib/stack/rank";
import type { StackTagInput } from "@/lib/plan/types";
import { ACCEPT_ATTR, ACCEPTED_EXTENSIONS } from "@/lib/projects/doc-extract";
import { SEED_INSTRUCTIONS_MAX } from "@/lib/projects/extract-seed";
import {
  createProjectFromExistingRepoAction,
  createProjectWithNewRepoAction,
  detectStackTagsAction,
  extractProjectSeedAction,
} from "../actions";

const DESCRIPTION_MAX = 4_000;

/**
 * Turn the picker's ticked keys into the action's payload, tagging each with
 * how it got there. `detected` is provenance only — the server re-derives every
 * label from the static catalog regardless, so a client that lies about the
 * source changes nothing about what reaches a prompt.
 */
function toStackTagInputs(selected: ReadonlySet<string>, detected: ReadonlySet<string>) {
  return [...selected].map(
    (serviceKey): StackTagInput => ({
      serviceKey,
      source: detected.has(serviceKey) ? "detected" : "manual",
    }),
  );
}

export function NewProjectClient({ githubLogin }: { githubLogin: string }) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="bg-muted text-muted-foreground flex h-8 w-8 items-center justify-center rounded-md">
              <FolderGit2 className="h-4 w-4" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight">New project</h1>
          </div>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Connect a repo you already have, or describe a new one and let the scaffolder draft a
            seed. You&apos;ll review the seed in{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">/changes</code>{" "}
            before anything is pushed.
          </p>
        </div>
        <Badge tone="info" className="hidden sm:inline-flex">
          <Github className="h-3 w-3" /> @{githubLogin}
        </Badge>
      </header>

      <Tabs defaultValue="connect" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="connect">
            <Link2 className="mr-2 h-3.5 w-3.5" /> Connect existing
          </TabsTrigger>
          <TabsTrigger value="create">
            <Sparkles className="mr-2 h-3.5 w-3.5" /> Create new
          </TabsTrigger>
        </TabsList>
        <TabsContent value="connect">
          <ConnectExistingForm />
        </TabsContent>
        <TabsContent value="create">
          <CreateNewRepoForm githubLogin={githubLogin} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Connect existing ─────────────────────────────────────────────────────

/**
 * Derive a default project name from a github URL. Returns null when we
 * can't pull a meaningful repo segment out of the input. We auto-fill the
 * name field with this value on every URL change UNTIL the operator
 * manually edits it (tracked by `nameTouched`).
 */
// Onboarding threads `?next=/welcome` so a freshly created project returns to
// the guided flow (step 3 — connect a runner) instead of landing on the project
// page and skipping runner setup. Only same-origin relative paths are honored,
// so the param can't be used to bounce the operator to an external URL.
function useNextDest(): string | null {
  const params = useSearchParams();
  const next = params.get("next");
  return next && next.startsWith("/") && next[1] !== "/" && next[1] !== "\\" ? next : null;
}

function deriveNameFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  // Match the repo segment from any of: full URL, SSH, owner/repo shorthand.
  const m = trimmed.match(
    /(?:github\.com[/:]|^)([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/i,
  );
  if (!m) return null;
  return m[2] ?? null;
}

/**
 * WI-14 follow-up - arm agent ticket-filing at creation time.
 *
 * The DB column default deliberately stays FALSE, so this is not a changed
 * default: it is the operator's own visible choice, made once, on the form they
 * are already filling in. Pre-ticked because a new project almost always wants
 * it (a decomposition ticket cannot do its job without it) and because
 * submitting a pre-ticked control the operator can see and untick is a
 * deliberate act - the same reasoning the stack picker's pre-ticked detection
 * runs on. What it does NOT do is reach backwards: an existing project keeps
 * whatever it has, and nobody's live board is armed underneath them.
 *
 * The copy leads with the guarantee rather than the capability, because "agents
 * can create work" is the scary reading and "it lands in Backlog and cannot run
 * until you move it" is the true one.
 */
function AgentTicketCreationToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm",
        disabled && "cursor-not-allowed opacity-60",
        checked && "border-primary/40 bg-primary/5",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="border-input accent-primary h-4 w-4 rounded"
      />
      <div className="flex flex-1 items-center gap-2">
        <Bot className="text-muted-foreground h-3.5 w-3.5" />
        <span className="font-medium">Let agents file tickets</span>
        <span className="text-muted-foreground text-xs">
          {checked
            ? "Out-of-scope work becomes a new Backlog ticket instead of being dropped. It can't run until you move it to Ready."
            : "Agents will report out-of-scope findings in comments only. Ticket decomposition won't work."}
        </span>
      </div>
    </label>
  );
}

function ConnectExistingForm() {
  const router = useRouter();
  const nextDest = useNextDest();
  const [repoUrl, setRepoUrl] = React.useState("");
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [tier, setTier] = React.useState<TeamTier>(DEFAULT_TEAM_TIER);
  const [projectType, setProjectType] = React.useState<ProjectType>(DEFAULT_PROJECT_TYPE);
  const [ecosystem, setEcosystem] = React.useState<EcosystemChoice>(DEFAULT_ECOSYSTEM);
  const [stack, setStack] = React.useState<Set<string>>(new Set());
  const [detected, setDetected] = React.useState<Set<string>>(new Set());
  // What the LAST scan suggested, so the next scan can retract exactly its own
  // suggestions without touching the operator's. A ref, not the `detected`
  // state: the scan callback must read the current value without the effect
  // re-subscribing on it (which would re-scan on every result).
  const detectedRef = React.useRef<ReadonlySet<string>>(new Set());
  const [scanning, setScanning] = React.useState(false);
  const [llm, setLlm] = React.useState<LlmDraft>(EMPTY_LLM_DRAFT);
  // Pre-ticked, and untickable - see AgentTicketCreationToggle for why that is
  // a visible operator choice rather than a changed default.
  const [agentTicketCreation, setAgentTicketCreation] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Import-time stack detection. Fires when the operator finishes typing a
  // parseable repo URL, and PRE-TICKS what it finds — it never decides for
  // them. Detection reads attacker-controlled repo manifests, so the operator
  // reviewing the ticked boxes before submit is the security control, not a
  // nicety (see lib/stack/detect-stack-tags.ts). Debounced so we don't scan on
  // every keystroke; a scan is best-effort and its failure is silent.
  React.useEffect(() => {
    const url = repoUrl.trim();
    if (deriveNameFromUrl(url) === null) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setScanning(true);
      const res = await detectStackTagsAction({ repoUrl: url });
      if (cancelled) return;
      setScanning(false);
      if (!res.ok) return;
      const found = new Set(res.serviceKeys);
      setStack((prev) => {
        // Retract the PREVIOUS scan's suggestions, keep the operator's own
        // ticks, then apply this scan's. Retyping the URL to a different repo
        // must not leave the old repo's services ticked — they'd be submitted
        // as `manual` (this scan no longer lists them), which is a provenance
        // lie, and they'd pin a stack the project doesn't actually run on.
        const next = new Set([...prev].filter((k) => !detectedRef.current.has(k)));
        for (const key of found) next.add(key);
        return next;
      });
      detectedRef.current = found;
      setDetected(found);
    }, 600);
    return () => {
      cancelled = true;
      setScanning(false);
      clearTimeout(timer);
    };
  }, [repoUrl]);

  // Keep the name auto-synced to the URL until the operator overrides it.
  React.useEffect(() => {
    if (nameTouched) return;
    const derived = deriveNameFromUrl(repoUrl);
    if (derived) setName(derived);
    // We intentionally don't depend on `nameTouched` here — the effect closes
    // over the current value and re-runs every URL change. Once touched, the
    // early-return kills the auto-sync.
  }, [repoUrl, nameTouched]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!repoUrl.trim() || !name.trim()) {
      setErr("Both fields are required");
      return;
    }
    setBusy(true);
    const res = await createProjectFromExistingRepoAction({
      name: name.trim(),
      repoUrl: repoUrl.trim(),
      teamTier: tier,
      projectType,
      stackEcosystem: ecosystem,
      stackTags: toStackTagInputs(stack, detected),
      llm: llmDraftToInput(llm),
      agentTicketCreation,
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      toast.error("Couldn't connect repo", { description: res.error });
      return;
    }
    toast.success("Project connected", {
      description: "You can switch to it from the topbar.",
    });
    router.push(nextDest ?? `/projects/${res.projectId}`);
  }

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle className="text-sm">Connect a GitHub repo</CardTitle>
          <CardDescription className="text-xs">
            Paste the repo URL. We&apos;ll verify your token can read it and link the project — no
            clones happen on this page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Repo URL"
            hint="https://github.com/owner/repo  — SSH and owner/repo shorthand also work"
          >
            <Input
              autoFocus
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              disabled={busy}
            />
          </Field>
          <Field
            label="Project name"
            hint="Shown in the topbar switcher and on /board. We pre-fill from the URL."
          >
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="my-cool-app"
              disabled={busy}
            />
          </Field>
          <PlatformPicker value={projectType} onChange={setProjectType} disabled={busy} />
          <EcosystemPicker value={ecosystem} onChange={setEcosystem} disabled={busy} />
          <TierPicker
            value={tier}
            onChange={(t) => setTier(t ?? DEFAULT_TEAM_TIER)}
            disabled={busy}
          />
          <details className="rounded-md border p-3">
            <summary className="text-muted-foreground cursor-pointer text-[11px] font-medium uppercase tracking-wide">
              Advanced: extra services
            </summary>
            <p className="text-muted-foreground mt-1 text-[11px]">
              The stack advisor (on the project page, after creation) is the primary way to pick a
              stack. Use this only to pin services outside its capability list.
            </p>
            <div className="mt-2">
              <StackTagPicker
                selected={stack}
                detected={detected}
                onChange={setStack}
                disabled={busy}
                scanning={scanning}
              />
            </div>
          </details>
          <LlmProviderFields draft={llm} onChange={setLlm} disabled={busy} />
          <AgentTicketCreationToggle
            checked={agentTicketCreation}
            onChange={setAgentTicketCreation}
            disabled={busy}
          />
          {err ? <ErrorBanner message={err} /> : null}
        </CardContent>
        <CardFooter className="justify-between border-t pt-4">
          <span className="text-muted-foreground text-xs">
            We&apos;ll call{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">
              GET /repos/owner/repo
            </code>{" "}
            with your token to confirm access.
          </span>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || repoUrl.trim().length === 0 || name.trim().length === 0}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Connecting…
              </>
            ) : (
              <>
                <Link2 className="h-3.5 w-3.5" />
                Connect repo
              </>
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

// ─── Create new ───────────────────────────────────────────────────────────

/** Stable empty set — the create-new tab detects nothing (empty repo). */
const EMPTY_DETECTED: ReadonlySet<string> = new Set();

function CreateNewRepoForm({ githubLogin }: { githubLogin: string }) {
  const router = useRouter();
  const nextDest = useNextDest();
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [descriptionTouched, setDescriptionTouched] = React.useState(false);
  // Distilled detail from an uploaded spec/PRD (parse-and-discard — the file is
  // never persisted). Feeds the plan opener as a richer first message. Shown as
  // an editable preview; the operator reviewing it is the trust control for
  // this attacker-influenced content.
  const [instructions, setInstructions] = React.useState("");
  const [docName, setDocName] = React.useState<string | null>(null);
  const [extracting, setExtracting] = React.useState(false);
  const [isPrivate, setIsPrivate] = React.useState(true);
  // Plan-first toggle. When checked, project creation also starts a
  // planning_session linked to the new project; the user lands on the
  // project page with the PlanSheet auto-opened to chat with the lead
  // agent. The scaffolder still runs in parallel so the repo is seeded.
  const [generatePlan, setGeneratePlan] = React.useState(true);
  const [tier, setTier] = React.useState<TeamTier>(DEFAULT_TEAM_TIER);
  const [projectType, setProjectType] = React.useState<ProjectType>(DEFAULT_PROJECT_TYPE);
  const [ecosystem, setEcosystem] = React.useState<EcosystemChoice>(DEFAULT_ECOSYSTEM);
  // Manual-only on this tab: the repo is created empty (`auto_init: false`), so
  // there is nothing to fingerprint at create time. Live detection for a repo
  // the scaffolder has since filled in is a documented follow-up.
  const [stack, setStack] = React.useState<Set<string>>(new Set());
  const [llm, setLlm] = React.useState<LlmDraft>(EMPTY_LLM_DRAFT);
  // Pre-ticked, and untickable - see AgentTicketCreationToggle for why that is
  // a visible operator choice rather than a changed default.
  const [agentTicketCreation, setAgentTicketCreation] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Mirror the slug GitHub will end up with so the operator sees what their
  // repo URL will look like before they hit submit.
  const slugPreview = React.useMemo(() => {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return slug.length > 0 ? slug : null;
  }, [name]);

  // Upload a spec/PRD/notes doc → server extracts text → LLM distills it into a
  // {name, description, instructions} seed that pre-fills the form. We never
  // clobber what the operator already typed (empty + untouched fields only);
  // `instructions` is a generated preview, so it always refreshes.
  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the operator re-pick the same file after an edit
    if (!file) return;
    setErr(null);
    setExtracting(true);
    setDocName(file.name);
    const fd = new FormData();
    fd.append("file", file);
    const res = await extractProjectSeedAction(fd);
    setExtracting(false);
    if (!res.ok) {
      setDocName(null);
      setErr(res.error);
      toast.error("Couldn't read that document", { description: res.error });
      return;
    }
    if (res.name && !nameTouched && name.trim().length === 0) setName(res.name);
    if (res.description && !descriptionTouched && description.trim().length === 0) {
      setDescription(res.description);
    }
    setInstructions(res.instructions);
    if (res.degraded) {
      toast.warning("Document added", {
        description:
          "We couldn't fully distill it, so the raw text is your description. Review before submitting.",
      });
    } else {
      toast.success("Document distilled", {
        description: "Review the generated name, description, and detail before submitting.",
      });
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    if (!description.trim()) {
      setErr("Description is required so the scaffolder knows what to build");
      return;
    }
    if (description.length > DESCRIPTION_MAX) {
      setErr(`Description must be ≤ ${DESCRIPTION_MAX} characters`);
      return;
    }
    setBusy(true);
    const res = await createProjectWithNewRepoAction({
      name: name.trim(),
      description: description.trim(),
      private: isPrivate,
      generatePlan,
      // Enrichment only — silently cap to the field bound rather than let an
      // over-long edit fail the whole create on the server's Zod `.max`.
      instructions: instructions.trim().slice(0, SEED_INSTRUCTIONS_MAX) || undefined,
      teamTier: tier,
      projectType,
      stackEcosystem: ecosystem,
      stackTags: toStackTagInputs(stack, EMPTY_DETECTED),
      llm: llmDraftToInput(llm),
      agentTicketCreation,
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      toast.error("Couldn't create project", { description: res.error });
      return;
    }
    if (res.planSessionId) {
      toast.success("Project created — plan session started", {
        description:
          "The scaffolder is filed and seeding the repo now. Chat with the lead agent to refine the backlog in parallel.",
      });
      router.push(`/projects/${res.projectId}?planSession=${res.planSessionId}`);
    } else {
      toast.success("Project created", {
        description:
          "Scaffolder ticket filed. Watch it converge on /board, then review on /changes.",
      });
      // The scaffolder can't run without a runner, so during onboarding we send
      // the operator back to finish runner setup (nextDest) rather than to a
      // project page where the ticket would sit idle. The plan-session path above
      // is left alone — that flow needs the operator on the project's plan chat.
      router.push(nextDest ?? `/projects/${res.projectId}`);
    }
  }

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle className="text-sm">Create a new GitHub repo</CardTitle>
          <CardDescription className="text-xs">
            Describe what you want. DevPilot creates the repo, files a{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">
              project_scaffolder
            </code>{" "}
            ticket, and the agent generates a sensible seed scaffolding. Nothing ships to GitHub
            until you push from{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">/changes</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DocSeedUpload
            docName={docName}
            extracting={extracting}
            disabled={busy}
            onFilePicked={onFilePicked}
          />
          <Field
            label="Name"
            hint="GitHub will convert this to a slug for the repo name."
            rightSlot={
              slugPreview ? (
                <span className="text-muted-foreground font-mono text-[10px]">
                  github.com/{githubLogin}/{slugPreview}
                </span>
              ) : null
            }
          >
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="My Todo App"
              disabled={busy}
            />
          </Field>
          <Field
            label={generatePlan ? "Project goal" : "Description"}
            hint={
              generatePlan
                ? "The lead agent opens the plan session with this as your first message. State the goal + any key constraints; you'll refine via chat."
                : "The scaffolder reads this verbatim. Be concrete about stack + key dependencies."
            }
            rightSlot={
              <span
                className={cn(
                  "tabular-nums",
                  description.length > DESCRIPTION_MAX
                    ? "text-destructive"
                    : description.length > 0
                      ? "text-success"
                      : "text-muted-foreground",
                )}
              >
                {description.length.toLocaleString()} / {DESCRIPTION_MAX.toLocaleString()}
              </span>
            }
          >
            <Textarea
              rows={6}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setDescriptionTouched(true);
              }}
              placeholder="A Next.js todo app with Supabase auth and a clean shadcn/ui frontend. Should support email login and per-user todo lists."
              disabled={busy}
            />
          </Field>
          {instructions.length > 0 ? (
            <Field
              label={generatePlan ? "Detail for the plan opener" : "Detail from your document"}
              hint={
                generatePlan
                  ? "Generated from your uploaded document — review before submitting. Appended to the lead agent's first message."
                  : "Generated from your uploaded document. Turn on “Generate a structured plan” to feed this to the lead agent."
              }
              rightSlot={
                <span
                  className={cn(
                    "tabular-nums",
                    instructions.length > SEED_INSTRUCTIONS_MAX
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {instructions.length.toLocaleString()} / {SEED_INSTRUCTIONS_MAX.toLocaleString()}
                </span>
              }
            >
              <Textarea
                rows={6}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                disabled={busy}
              />
            </Field>
          ) : null}
          <PlatformPicker value={projectType} onChange={setProjectType} disabled={busy} />
          <EcosystemPicker value={ecosystem} onChange={setEcosystem} disabled={busy} />
          <TierPicker
            value={tier}
            onChange={(t) => setTier(t ?? DEFAULT_TEAM_TIER)}
            disabled={busy}
          />
          <details className="rounded-md border p-3">
            <summary className="text-muted-foreground cursor-pointer text-[11px] font-medium uppercase tracking-wide">
              Advanced: extra services
            </summary>
            <p className="text-muted-foreground mt-1 text-[11px]">
              The stack advisor (on the project page, after creation) is the primary way to pick a
              stack. Use this only to pin services outside its capability list.
            </p>
            <div className="mt-2">
              <StackTagPicker selected={stack} onChange={setStack} disabled={busy} />
            </div>
          </details>
          <LlmProviderFields draft={llm} onChange={setLlm} disabled={busy} />
          <label
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm",
              busy && "cursor-not-allowed opacity-60",
              generatePlan && "border-primary/40 bg-primary/5",
            )}
          >
            <input
              type="checkbox"
              checked={generatePlan}
              onChange={(e) => setGeneratePlan(e.target.checked)}
              disabled={busy}
              className="border-input accent-primary h-4 w-4 rounded"
            />
            <div className="flex flex-1 items-center gap-2">
              <ListChecks className="text-muted-foreground h-3.5 w-3.5" />
              <span className="font-medium">Generate a structured plan</span>
              <span className="text-muted-foreground text-xs">
                {generatePlan
                  ? "Plan session starts alongside the scaffolder; refine via chat, then commit the backlog."
                  : "Skip planning — scaffolder reads the description verbatim."}
              </span>
            </div>
          </label>
          <AgentTicketCreationToggle
            checked={agentTicketCreation}
            onChange={setAgentTicketCreation}
            disabled={busy}
          />
          <label
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm",
              busy && "cursor-not-allowed opacity-60",
            )}
          >
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              disabled={busy}
              className="border-input accent-primary h-4 w-4 rounded"
            />
            <div className="flex flex-1 items-center gap-2">
              {isPrivate ? (
                <Lock className="text-muted-foreground h-3.5 w-3.5" />
              ) : (
                <Unlock className="text-muted-foreground h-3.5 w-3.5" />
              )}
              <span className="font-medium">{isPrivate ? "Private repo" : "Public repo"}</span>
              <span className="text-muted-foreground text-xs">
                {isPrivate
                  ? "Only you (and collaborators) can see it."
                  : "Visible to anyone on GitHub."}
              </span>
            </div>
          </label>
          {err ? <ErrorBanner message={err} /> : null}
        </CardContent>
        <CardFooter className="justify-between border-t pt-4">
          <span className="text-muted-foreground text-xs">
            Repo gets created empty — the scaffolder writes the first commit.
          </span>
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy ||
              name.trim().length === 0 ||
              description.trim().length === 0 ||
              description.length > DESCRIPTION_MAX
            }
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Create & scaffold
              </>
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

// ─── small shared bits ────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
  rightSlot,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
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
      {hint && <p className="text-muted-foreground mt-1 text-[11px]">{hint}</p>}
    </div>
  );
}

/**
 * Upload a spec / PRD / notes document to auto-seed the form. Accepts Markdown,
 * text, PDF, and Word (.docx); the server extracts the text, an LLM distills it,
 * and the result pre-fills name / description / detail. The file is
 * parse-and-discard — never stored.
 */
function DocSeedUpload({
  docName,
  extracting,
  disabled,
  onFilePicked,
}: {
  docName: string | null;
  extracting: boolean;
  disabled: boolean;
  onFilePicked: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const inputId = React.useId();
  return (
    <div className="border-primary/30 bg-primary/5 rounded-md border border-dashed p-3">
      <label
        htmlFor={inputId}
        className={cn(
          "flex cursor-pointer items-center gap-3 text-sm",
          (disabled || extracting) && "cursor-not-allowed opacity-60",
        )}
      >
        <div className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
          {extracting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FileUp className="h-4 w-4" />
          )}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 font-medium">
            <Wand2 className="text-primary h-3.5 w-3.5" />
            {extracting ? "Reading your document…" : "Seed from a document"}
          </div>
          <p className="text-muted-foreground text-xs">
            {docName && !extracting ? (
              <>
                Loaded <span className="font-mono">{docName}</span> — review the fields below.
              </>
            ) : (
              <>
                Upload a spec, PRD, or notes ({ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(", ")})
                and we&apos;ll auto-fill the name, description, and plan detail. Nothing is stored.
              </>
            )}
          </p>
        </div>
      </label>
      <input
        id={inputId}
        type="file"
        accept={ACCEPT_ATTR}
        className="sr-only"
        onChange={onFilePicked}
        disabled={disabled || extracting}
      />
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
    >
      {message}
    </p>
  );
}
