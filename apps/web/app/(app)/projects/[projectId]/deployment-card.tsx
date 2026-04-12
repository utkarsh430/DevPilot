"use client";

// The DeploymentCard — Vercel link state, the production branch, and what that
// branch actually means.
//
// ── What this card is FOR ──────────────────────────────────────────────────
// Linking a repo to Vercel turns on push-to-deploy: every push to the Vercel
// project's production branch goes live, with no approval step. DevPilot's agents
// push constantly and auto-land merges completed tickets on its own. That is a
// real and defensible workflow — production tracking the integration branch is
// the intended shape here — but it must be a thing the operator KNOWS, in words,
// on the screen, not something they infer later from a surprise deploy.
//
// So three facts are rendered as primary content, never in a tooltip and never
// behind a disclosure:
//
//   1. Which branch Vercel deploys production from, read LIVE from Vercel.
//   2. What that means, spelled out ("every push to X deploys to production
//      automatically, without further approval") — and, when auto-land targets
//      that branch, that completed agent tickets therefore deploy themselves.
//   3. Whether the live branch matches the branch this project expects, with the
//      manual dashboard steps when it does not. DevPilot cannot set the
//      production branch — it is read-only in Vercel's API — so surfacing the
//      gap IS the feature.
//
// Every string in 1-3 comes from the pure, unit-tested rules in
// `lib/vercel/deploy-policy.ts`. None of it is composed in JSX, so the wording
// is reviewable and testable in one place.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  HelpCircle,
  Link2,
  Loader2,
  Pencil,
  Rocket,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import {
  describeProductionBranch,
  decideBranchAlignment,
  type ProdDeployMode,
  type ProductionAutoDeploy,
} from "@/lib/vercel/deploy-policy";
import {
  createVercelProjectAction,
  linkVercelProjectAction,
  listVercelProjectsAction,
  setDesiredProductionBranchAction,
  setVercelDeployModeAction,
  unlinkVercelProjectAction,
  type VercelProjectOption,
} from "./vercel-actions";
import { EnvPushSection } from "./env-push-section";
import { DeploySection } from "./deploy-section";
import { RollbackSection } from "./rollback-section";
import type { DeploymentRecord } from "@/lib/vercel/deploy-write";

export type DeploymentCardProps = {
  projectId: string;
  projectName: string;
  githubOwner: string | null;
  githubRepo: string | null;
  defaultBranch: string;
  integrationBranch: string | null;
  autoLandEnabled: boolean;
  /** Live link state, assembled server-side by `loadVercelLinkStatus`. */
  linked: boolean;
  vercelProjectId: string | null;
  vercelProjectName: string | null;
  dashboardUrl: string;
  state: ProductionAutoDeploy;
  productionBranch: string | null;
  branchIsStale: boolean;
  desiredBranch: string | null;
  recordedMode: ProdDeployMode | null;
  /** Why the live read failed, when it did. Already scrubbed. */
  statusError: string | null;
  /** Is a Vercel token configured at all? Drives the empty state. */
  tokenConfigured: boolean;
  /** Recent deployments, seeded server-side so the list paints immediately. */
  deployments: DeploymentRecord[];
};

const TONE_CLASS: Record<"ok" | "warn" | "danger", string> = {
  ok: "border-success/40 bg-success/10",
  warn: "border-warning/40 bg-warning/10",
  danger: "border-destructive/40 bg-destructive/10",
};

const TONE_ICON: Record<"ok" | "warn" | "danger", React.ElementType> = {
  ok: ShieldCheck,
  warn: AlertTriangle,
  danger: AlertTriangle,
};

export function DeploymentCard(props: DeploymentCardProps) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [unlinkOpen, setUnlinkOpen] = React.useState(false);
  const [branchOpen, setBranchOpen] = React.useState(false);

  const hasRepo = Boolean(props.githubOwner && props.githubRepo);

  // The production statement + branch alignment, both from the pure rules.
  const statement = describeProductionBranch({
    state: props.state,
    productionBranch: props.productionBranch,
    branchIsStale: props.branchIsStale,
    integrationBranch: props.integrationBranch,
    autoLandEnabled: props.autoLandEnabled,
    defaultBranch: props.defaultBranch,
    intended: props.recordedMode === "git_auto",
  });
  const alignment = decideBranchAlignment({
    desiredBranch: props.desiredBranch,
    liveBranch: props.productionBranch,
    branchIsStale: props.branchIsStale,
  });

  async function run<T>(
    fn: () => Promise<
      { ok: true; value: T; warning?: string } | { ok: false; error: string; href?: string }
    >,
    successMessage: string,
  ) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error, {
        ...(res.href
          ? {
              action: {
                label: "Open",
                onClick: () => window.open(res.href, "_blank", "noopener,noreferrer"),
              },
            }
          : {}),
      });
      return;
    }
    if (res.warning) {
      // A warning is NOT a success toast with extra text — it is the operator's
      // only notice that production may be armed, so it gets the warning
      // treatment and does not auto-dismiss quickly.
      toast.warning(successMessage, { description: res.warning, duration: 30_000 });
    } else {
      toast.success(successMessage);
    }
    setLinkOpen(false);
    setCreateOpen(false);
    setUnlinkOpen(false);
    setBranchOpen(false);
    router.refresh();
  }

  const StatementIcon = TONE_ICON[statement.tone];

  return (
    <div className="bg-card rounded-xl border">
      <div className="flex items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <Rocket className="text-muted-foreground h-4 w-4" />
          <span className="text-sm font-medium">Deployment</span>
          <Badge tone={props.linked ? "ok" : "muted"} className="text-[10px]">
            {props.linked ? "Vercel linked" : "Not linked"}
          </Badge>
        </div>
        {props.linked ? (
          <div className="flex items-center gap-1">
            <a
              href={props.dashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
            >
              <ExternalLink className="h-3 w-3" />
              Vercel
            </a>
            <button
              type="button"
              onClick={() => setUnlinkOpen(true)}
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
            >
              <Unlink className="h-3 w-3" />
              Unlink
            </button>
          </div>
        ) : null}
      </div>

      {!props.linked ? (
        <UnlinkedBody
          {...props}
          hasRepo={hasRepo}
          busy={busy}
          onLink={() => setLinkOpen(true)}
          onCreate={() => setCreateOpen(true)}
        />
      ) : (
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <Field label="Vercel project" value={props.vercelProjectName ?? "—"} mono />
            <Field label="Project id" value={props.vercelProjectId ?? "—"} mono />
            <Field
              label="Repository"
              value={hasRepo ? `${props.githubOwner}/${props.githubRepo}` : "—"}
              mono
            />
          </div>

          {/* ── (1) + (2): the branch and what it means. The primary content of
                 this card, and the reason it exists. ─────────────────────── */}
          <div className={`rounded-lg border p-4 ${TONE_CLASS[statement.tone]}`}>
            <div className="flex items-start gap-2.5">
              <StatementIcon
                className={`mt-0.5 h-4 w-4 shrink-0 ${
                  statement.tone === "ok"
                    ? "text-success"
                    : statement.tone === "danger"
                      ? "text-destructive"
                      : "text-warning"
                }`}
              />
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
                    Production branch
                  </span>
                  <code className="text-sm font-medium">{props.productionBranch ?? "unknown"}</code>
                  {props.branchIsStale ? (
                    <Badge tone="muted" className="text-[10px]">
                      unconfirmed
                    </Badge>
                  ) : null}
                </div>
                <p className="text-foreground/90 text-sm font-medium">{statement.headline}</p>
                {statement.detail.map((line, i) => (
                  <p key={i} className="text-foreground/80 text-xs">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          </div>

          {/* ── (3): does the live branch match what this project expects? ─── */}
          {alignment.status === "misaligned" || alignment.status === "unknown" ? (
            <div className="border-warning/40 bg-warning/10 rounded-lg border p-4">
              <div className="flex items-start gap-2.5">
                {alignment.status === "unknown" ? (
                  <HelpCircle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
                )}
                <div className="min-w-0 space-y-2">
                  <p className="text-foreground/90 text-sm font-medium">{alignment.summary}</p>
                  <ol className="text-foreground/80 list-decimal space-y-1 pl-4 text-xs">
                    {alignment.manualSteps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
              </div>
            </div>
          ) : alignment.status === "aligned" ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <CheckCircle2 className="text-success h-3.5 w-3.5" />
              {alignment.summary}
            </p>
          ) : null}

          {/* Expected branch — editable, because DevPilot can only hold the
              intent, and an intent nobody can correct is worse than none. */}
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                <GitBranch className="text-muted-foreground h-3.5 w-3.5" />
                Expected production branch
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">
                What this project expects Vercel to deploy production from —{" "}
                <code>{props.desiredBranch ?? "not set"}</code>. DevPilot compares this against
                Vercel and warns when they differ; it cannot change it for you, because Vercel
                exposes the production branch as read-only to its API.
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setBranchOpen(true)}
              disabled={busy}
              className="shrink-0"
            >
              <Pencil className="h-3 w-3" /> Edit
            </Button>
          </div>

          {/* The DevPilot gate. A separate axis from the branch. */}
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium">Deploy production from git pushes</div>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {props.recordedMode === "devpilot_gated"
                  ? "Off — you asked DevPilot to stop git pushes deploying to production. Preview deployments still build."
                  : props.recordedMode === "git_auto"
                    ? "On — you chose to let pushes to the production branch deploy themselves."
                    : "No preference recorded for this project."}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant={props.recordedMode === "devpilot_gated" ? "default" : "ghost"}
                disabled={busy || props.recordedMode === "devpilot_gated"}
                onClick={() =>
                  void run(
                    () =>
                      setVercelDeployModeAction({
                        projectId: props.projectId,
                        mode: "devpilot_gated",
                      }),
                    "Git pushes will no longer deploy to production.",
                  )
                }
              >
                Off
              </Button>
              <Button
                size="sm"
                variant={props.recordedMode === "git_auto" ? "default" : "ghost"}
                disabled={busy || props.recordedMode === "git_auto"}
                onClick={() =>
                  void run(
                    () =>
                      setVercelDeployModeAction({
                        projectId: props.projectId,
                        mode: "git_auto",
                      }),
                    "Pushes to the production branch now deploy to production automatically.",
                  )
                }
              >
                On
              </Button>
            </div>
          </div>

          {/* Env vars. A third axis again: independent of the branch and of the
              gate, and the only one of the three that moves secrets between
              systems — so it gets its own confirm screen rather than a button. */}
          <EnvPushSection projectId={props.projectId} vercelProjectName={props.vercelProjectName} />

          {/* Deploy. Last, because everything above it — the branch, the gate,
              the env vars — is what a deploy will actually ship. */}
          <DeploySection
            projectId={props.projectId}
            defaultRef={props.integrationBranch ?? props.defaultBranch}
            productionBranch={props.branchIsStale ? null : props.productionBranch}
            initial={props.deployments}
          />

          {/* Rollback. After the deploy controls, because it is the thing you
              reach for when one of them went wrong — and because its own
              rolled-back banner needs to sit next to what it explains. */}
          <RollbackSection projectId={props.projectId} />

          {props.statusError ? (
            <p className="text-muted-foreground border-t pt-3 text-xs">
              Live state could not be read from Vercel: {props.statusError}
            </p>
          ) : null}
        </div>
      )}

      <LinkExistingDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        projectId={props.projectId}
        defaultDesiredBranch={props.desiredBranch ?? props.integrationBranch ?? props.defaultBranch}
        autoLandBranch={props.autoLandEnabled ? props.integrationBranch : null}
        busy={busy}
        onSubmit={(vercelProjectId, mode, desiredBranch) =>
          void run(
            () =>
              linkVercelProjectAction({
                projectId: props.projectId,
                vercelProjectId,
                mode,
                desiredBranch,
              }),
            "Linked to Vercel.",
          )
        }
      />

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        suggestedName={props.projectName}
        repo={hasRepo ? `${props.githubOwner}/${props.githubRepo}` : null}
        defaultDesiredBranch={props.desiredBranch ?? props.integrationBranch ?? props.defaultBranch}
        autoLandBranch={props.autoLandEnabled ? props.integrationBranch : null}
        busy={busy}
        onSubmit={(name, mode, desiredBranch) =>
          void run(
            () =>
              createVercelProjectAction({
                projectId: props.projectId,
                name,
                mode,
                desiredBranch,
              }),
            "Vercel project created and linked.",
          )
        }
      />

      <Dialog open={branchOpen} onOpenChange={setBranchOpen}>
        <DialogContent>
          <DialogTitle>Expected production branch</DialogTitle>
          <DialogDescription>
            The branch you expect Vercel to deploy production from. DevPilot records it and warns
            while Vercel disagrees — it cannot change the setting, because Vercel&apos;s API exposes
            the production branch as read-only.
          </DialogDescription>
          <BranchForm
            initial={props.desiredBranch ?? props.integrationBranch ?? props.defaultBranch}
            busy={busy}
            onCancel={() => setBranchOpen(false)}
            onSubmit={(branch) =>
              void run(
                () => setDesiredProductionBranchAction({ projectId: props.projectId, branch }),
                "Expected production branch saved.",
              )
            }
          />
        </DialogContent>
      </Dialog>

      <Dialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <DialogContent>
          <DialogTitle>Unlink from Vercel</DialogTitle>
          <DialogDescription>
            DevPilot forgets the link. It does <strong>not</strong> delete the Vercel project and
            does <strong>not</strong> change anything on Vercel&apos;s side — so if pushes to{" "}
            <code>{props.productionBranch ?? "the production branch"}</code> currently deploy to
            production, they will keep doing so, with DevPilot no longer showing it.
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnlinkOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(
                  () => unlinkVercelProjectAction({ projectId: props.projectId }),
                  "Unlinked from Vercel.",
                )
              }
            >
              Unlink
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
        {label}
      </div>
      <div className={`truncate text-xs ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function UnlinkedBody(
  props: DeploymentCardProps & {
    hasRepo: boolean;
    busy: boolean;
    onLink: () => void;
    onCreate: () => void;
  },
) {
  if (!props.tokenConfigured) {
    return (
      <div className="px-5 py-4">
        <p className="text-muted-foreground text-sm">
          No Vercel credential is configured for this instance yet.
        </p>
        <a
          href="/settings/platform-secrets"
          className="text-primary mt-2 inline-flex items-center gap-1.5 text-xs hover:underline"
        >
          Add a Vercel token <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    );
  }
  if (!props.hasRepo) {
    return (
      <div className="px-5 py-4">
        <p className="text-muted-foreground text-sm">
          This project isn&apos;t connected to a GitHub repository, so there is nothing for Vercel
          to deploy. Connect the repo first.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 px-5 py-4">
      <p className="text-muted-foreground text-sm">
        Link this project to Vercel to deploy{" "}
        <code>
          {props.githubOwner}/{props.githubRepo}
        </code>
        .
      </p>
      <p className="text-muted-foreground text-xs">
        Linking turns on Vercel&apos;s push-to-deploy. You will be asked to decide, explicitly,
        whether pushes to the production branch may deploy to production — before anything is
        linked.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={props.onCreate} disabled={props.busy}>
          <Rocket className="h-3 w-3" /> Create Vercel project
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onLink} disabled={props.busy}>
          <Link2 className="h-3 w-3" /> Link existing
        </Button>
      </div>
    </div>
  );
}

/**
 * The mode chooser.
 *
 * There is deliberately NO pre-selected option and the submit button stays
 * disabled until one is picked. That is the whole point: the requirement is that
 * arming production auto-deploy cannot be a side effect of clicking "Link". A
 * default — either default — would make it exactly that.
 */
function ModeChooser({
  value,
  onChange,
  branch,
  autoLandTargetsBranch,
}: {
  value: ProdDeployMode | null;
  onChange: (m: ProdDeployMode) => void;
  branch: string;
  autoLandTargetsBranch: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">
        Should pushes to <code>{branch}</code> deploy to production?
      </div>
      <ModeOption
        selected={value === "git_auto"}
        onSelect={() => onChange("git_auto")}
        title="Yes — deploy every push automatically"
        body={
          autoLandTargetsBranch
            ? `Every push to "${branch}" goes live immediately, with no approval. Auto-land merges every completed agent ticket into "${branch}", so completed tickets will deploy themselves to production.`
            : `Every push to "${branch}" goes live immediately, with no approval step of any kind.`
        }
      />
      <ModeOption
        selected={value === "devpilot_gated"}
        onSelect={() => onChange("devpilot_gated")}
        title="No — only deploy when I trigger it from DevPilot"
        body={`DevPilot asks Vercel to stop git pushes deploying to production. Preview deployments still build on every push. DevPilot verifies this took effect and tells you if it could not.`}
      />
    </div>
  );
}

function ModeOption({
  selected,
  onSelect,
  title,
  body,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
        selected ? "border-primary bg-primary/5" : "hover:border-foreground/30"
      }`}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-muted-foreground text-xs">{body}</span>
    </button>
  );
}

function BranchForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (branch: string) => void;
}) {
  const [value, setValue] = React.useState(initial);
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value.trim());
      }}
    >
      <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CreateDialog({
  open,
  onOpenChange,
  suggestedName,
  repo,
  defaultDesiredBranch,
  autoLandBranch,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  suggestedName: string;
  repo: string | null;
  defaultDesiredBranch: string;
  /** Auto-land's target, when armed. Needed so the chooser can say — at the
   *  moment of the decision, not after it — that completed agent tickets will
   *  deploy themselves. That is the configuration this project normally runs, so
   *  it is the sentence most likely to matter. */
  autoLandBranch: string | null;
  busy: boolean;
  onSubmit: (name: string, mode: ProdDeployMode, desiredBranch: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [mode, setMode] = React.useState<ProdDeployMode | null>(null);
  const [branch, setBranch] = React.useState(defaultDesiredBranch);

  React.useEffect(() => {
    if (open) {
      setMode(null);
      setBranch(defaultDesiredBranch);
    }
  }, [open, defaultDesiredBranch]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create a Vercel project</DialogTitle>
        <DialogDescription>
          Creates a new Vercel project linked to <code>{repo ?? "this repository"}</code>.
        </DialogDescription>
        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Vercel project name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={suggestedName}
              disabled={busy}
            />
            <p className="text-muted-foreground text-[11px]">
              Leave blank to derive one from the DevPilot project name.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Expected production branch</label>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} disabled={busy} />
            <p className="text-muted-foreground text-[11px]">
              Vercel decides its own production branch when the project is created (normally the
              repository&apos;s default branch) and its API will not let DevPilot change that.
              Record what you expect here and DevPilot will tell you, with steps, if Vercel
              disagrees.
            </p>
          </div>
          <ModeChooser
            value={mode}
            onChange={setMode}
            branch={branch || defaultDesiredBranch}
            autoLandTargetsBranch={
              autoLandBranch !== null && autoLandBranch === (branch || defaultDesiredBranch)
            }
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || mode === null}
            onClick={() => mode && onSubmit(name, mode, branch)}
          >
            {busy ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> Creating…
              </>
            ) : (
              "Create and link"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkExistingDialog({
  open,
  onOpenChange,
  projectId,
  defaultDesiredBranch,
  autoLandBranch,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  defaultDesiredBranch: string;
  /** See `CreateDialog`. */
  autoLandBranch: string | null;
  busy: boolean;
  onSubmit: (vercelProjectId: string, mode: ProdDeployMode, desiredBranch: string) => void;
}) {
  const [options, setOptions] = React.useState<VercelProjectOption[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<ProdDeployMode | null>(null);
  const [branch, setBranch] = React.useState(defaultDesiredBranch);

  React.useEffect(() => {
    if (!open) return;
    setSelected(null);
    setMode(null);
    setBranch(defaultDesiredBranch);
    setOptions(null);
    setLoadError(null);
    void listVercelProjectsAction(projectId).then((res) => {
      if (res.ok) setOptions(res.value);
      else setLoadError(res.error);
    });
  }, [open, projectId, defaultDesiredBranch]);

  const chosen = options?.find((o) => o.id === selected) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Link an existing Vercel project</DialogTitle>
        <DialogDescription>
          Pick the Vercel project that already deploys this repository.
        </DialogDescription>
        <div className="mt-4 space-y-4">
          {loadError ? (
            <p className="text-destructive text-sm">{loadError}</p>
          ) : options === null ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your Vercel projects…
            </p>
          ) : options.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This Vercel account has no projects yet. Use “Create Vercel project” instead.
            </p>
          ) : (
            <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setSelected(o.id)}
                  className={`flex w-full flex-col gap-0.5 rounded-lg border p-3 text-left transition-colors ${
                    selected === o.id ? "border-primary bg-primary/5" : "hover:border-foreground/30"
                  }`}
                >
                  <span className="text-sm font-medium">{o.name ?? o.id}</span>
                  <span className="text-muted-foreground font-mono text-[11px]">
                    {o.repo ?? "no git repository linked"}
                    {o.productionBranch ? ` · production: ${o.productionBranch}` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}

          {chosen ? (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Expected production branch</label>
                <Input value={branch} onChange={(e) => setBranch(e.target.value)} disabled={busy} />
                <p className="text-muted-foreground text-[11px]">
                  {chosen.productionBranch
                    ? `This Vercel project currently deploys production from "${chosen.productionBranch}". DevPilot cannot change that — Vercel's API exposes it read-only — but it will warn you here while it differs from what you record.`
                    : "Vercel did not report a production branch for this project."}
                </p>
              </div>
              <ModeChooser
                value={mode}
                onChange={setMode}
                branch={chosen.productionBranch ?? (branch || defaultDesiredBranch)}
                autoLandTargetsBranch={
                  autoLandBranch !== null &&
                  autoLandBranch === (chosen.productionBranch ?? (branch || defaultDesiredBranch))
                }
              />
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || selected === null || mode === null}
            onClick={() => selected && mode && onSubmit(selected, mode, branch)}
          >
            {busy ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
