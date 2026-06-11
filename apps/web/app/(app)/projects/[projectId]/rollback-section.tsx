"use client";

// The rollback surface: revert production to a previous deployment, see why the
// other candidates are unavailable, and undo it afterwards.
//
// ── Three things this component is shaped around ──────────────────────────
//
// 1. THE ROLLED-BACK BANNER IS THE MOST VALUABLE THING HERE, and it is
//    persistent, not a toast. After a rollback Vercel turns off auto-assignment
//    of production domains, so pushes to the production branch stop going live —
//    including every completed agent ticket auto-land merges into it, with no
//    error anywhere. Without a permanent banner that presents days later as
//    "DevPilot's deploys silently stopped working".
//
// 2. INELIGIBLE TARGETS ARE SHOWN, DISABLED, WITH THE REASON. A deployment that
//    vanishes from a list reads as a DevPilot bug; one that is present and says
//    "rolling back more than one step requires Pro" is a product telling the
//    truth about a constraint. Multi-step rollback is a Pro feature, so the list
//    is built and gated rather than hidden — the operator sees exactly what
//    upgrading buys, and the day they upgrade nothing here needs to change.
//
// 3. TYPE-TO-CONFIRM, matching the production-deploy dialog. A rollback changes
//    what live users are served immediately, with no build in between, so the
//    operator types the deployment id — the thing confirmed is the thing that
//    goes live. The server re-checks it and re-derives eligibility independently;
//    this dialog is the ergonomics, not the gate.
//
// Every warning string comes from the pure `lib/vercel/rollback-state.ts`, not
// from JSX, so the operator's only notice about the three documented footguns is
// reviewable and testable in one place.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  Lock,
  RotateCcw,
  Undo2,
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
import type { RollbackTarget } from "@/lib/vercel/rollback-state";
import {
  loadRollbackTargetsAction,
  rollbackDeploymentAction,
  undoRollbackAction,
  type RollbackTargetsView,
} from "./vercel-actions";

export function RollbackSection({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [view, setView] = React.useState<RollbackTargetsView | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmTarget, setConfirmTarget] = React.useState<RollbackTarget | null>(null);
  const [undoOpen, setUndoOpen] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const res = await loadRollbackTargetsAction(projectId);
    if (res.ok) {
      setView(res.value);
      setLoadError(null);
    } else {
      setLoadError(res.error);
    }
  }, [projectId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(
    fn: () => Promise<
      { ok: true; value: unknown; warning?: string } | { ok: false; error: string }
    >,
  ) {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error, { duration: 15_000 });
        return false;
      }
      // The "warning" here carries what Vercel actually committed to — including
      // the case where a promotion was QUEUED behind a rolling release and
      // production has not moved. That is not decoration, so it gets its own
      // long-lived toast rather than being appended to a success line.
      toast.success("Vercel accepted the change.");
      if (res.warning) toast.warning(res.warning, { duration: 20_000 });
      await refresh();
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-2 border-t pt-4">
        <SectionHeading />
        <p className="text-muted-foreground text-xs">{loadError}</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="space-y-2 border-t pt-4">
        <SectionHeading />
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading deployment history…
        </p>
      </div>
    );
  }

  const eligible = view.targets.filter((t) => t.eligibility.eligible);

  return (
    <div className="space-y-3 border-t pt-4">
      <SectionHeading />

      {/* (1) The persistent rolled-back state. See the header. */}
      {view.rolledBack ? (
        <div className="border-warning/40 bg-warning/10 rounded-lg border p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 space-y-2">
              <p className="text-foreground/90 text-sm font-medium">{view.rolledBack.headline}</p>
              {view.rolledBack.detail.map((line, i) => (
                <p key={i} className="text-foreground/80 text-xs">
                  {line}
                </p>
              ))}
              {view.rolledBack.undoDeploymentId ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || view.aliasJobInFlight}
                  onClick={() => setUndoOpen(true)}
                >
                  <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                  Undo rollback…
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {view.aliasJobInFlight ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Vercel is repointing the production domains. Nothing else can be started until it settles.
        </p>
      ) : null}

      {view.targets.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          DevPilot has no record of a production deployment for this project yet, so there is
          nothing to roll back to. Deployments DevPilot did not trigger are not in this list.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              Rolling back repoints production at a previous build. It does not rebuild anything and
              takes effect immediately.
            </p>
            {view.previousProductionId ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || view.aliasJobInFlight}
                onClick={() =>
                  setConfirmTarget(
                    view.targets.find(
                      (t) => t.record.vercelDeploymentId === view.previousProductionId,
                    ) ?? null,
                  )
                }
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Revert to previous…
              </Button>
            ) : null}
          </div>

          <ul className="divide-y rounded-md border">
            {view.targets.map((t) => (
              <TargetRow
                key={t.record.id || t.record.vercelDeploymentId}
                target={t}
                busy={busy || view.aliasJobInFlight}
                vercelAgrees={
                  view.vercelCandidateIds === null
                    ? null
                    : view.vercelCandidateIds.includes(t.record.vercelDeploymentId)
                }
                onPick={() => setConfirmTarget(t)}
              />
            ))}
          </ul>

          {eligible.length === 0 && !view.rolledBack ? (
            <p className="text-muted-foreground text-xs">
              No deployment here can be rolled back to right now. Each row above says why.
            </p>
          ) : null}

          {view.vercelCandidateIds === null ? (
            <p className="text-muted-foreground text-xs">
              DevPilot could not cross-check this list against Vercel&apos;s own eligible set, so
              the rows are from DevPilot&apos;s records alone. Vercel decides eligibility at the
              moment you roll back.
            </p>
          ) : null}
        </>
      )}

      <ConfirmDialog
        target={confirmTarget}
        warnings={view.warnings}
        busy={busy}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        onConfirm={async (deploymentId, confirmDeploymentId) => {
          const ok = await run(() =>
            rollbackDeploymentAction({ projectId, deploymentId, confirmDeploymentId }),
          );
          if (ok) setConfirmTarget(null);
        }}
      />

      <UndoDialog
        open={undoOpen}
        deploymentId={view.rolledBack?.undoDeploymentId ?? null}
        busy={busy}
        onOpenChange={setUndoOpen}
        onConfirm={async (confirmDeploymentId) => {
          const ok = await run(() => undoRollbackAction({ projectId, confirmDeploymentId }));
          if (ok) setUndoOpen(false);
        }}
      />
    </div>
  );
}

function SectionHeading() {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <History className="text-muted-foreground h-3.5 w-3.5" />
        Rollback
      </p>
      <p className="text-muted-foreground text-xs">
        Point production back at a deployment that has served it before.
      </p>
    </div>
  );
}

/**
 * One candidate row.
 *
 * An ineligible row is RENDERED, with its reason, and its button is disabled —
 * never omitted. The plan-gated case gets a lock icon rather than a warning
 * triangle: it is a constraint, not a fault, and dressing it as an error would
 * train the operator to ignore the rows that are faults.
 */
function TargetRow({
  target,
  busy,
  vercelAgrees,
  onPick,
}: {
  target: RollbackTarget;
  busy: boolean;
  /** Null when the cross-check could not run — rendered as unconfirmed, never as
   *  ineligible. */
  vercelAgrees: boolean | null;
  onPick: () => void;
}) {
  const { record: r, eligibility } = target;
  const planGated = !eligibility.eligible && eligibility.reason === "plan_gated";

  return (
    <li className="space-y-1.5 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {target.isLive ? (
          <Badge tone="ok">Live</Badge>
        ) : target.isPreviousProduction ? (
          <Badge tone="warn">Previous</Badge>
        ) : null}
        {r.branch ? <code className="font-mono font-medium">{r.branch}</code> : null}
        {r.commitSha ? (
          <code className="text-muted-foreground font-mono">{r.commitSha.slice(0, 7)}</code>
        ) : null}
        {r.promotedAt ? (
          <Badge tone="muted" className="text-[10px]">
            promoted
          </Badge>
        ) : null}
        <span className="text-muted-foreground ml-auto">
          {r.becameProductionAt ? `live from ${formatWhen(r.becameProductionAt)}` : "never live"}
        </span>
      </div>

      {eligibility.eligible ? (
        eligibility.note ? (
          <p className="text-muted-foreground">{eligibility.note}</p>
        ) : null
      ) : (
        <p className="text-muted-foreground flex items-start gap-1.5">
          {planGated ? (
            <Lock className="mt-0.5 h-3 w-3 shrink-0" />
          ) : (
            <AlertTriangle className="text-warning mt-0.5 h-3 w-3 shrink-0" />
          )}
          <span>{eligibility.message}</span>
        </p>
      )}

      {/* The cross-check against Vercel's own eligibility rule. Only ever
          surfaced as extra information — DevPilot does not remove a row because a
          cross-check disagreed, because Vercel decides at request time anyway. */}
      {eligibility.eligible && vercelAgrees === false ? (
        <p className="text-muted-foreground flex items-start gap-1.5">
          <AlertTriangle className="text-warning mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Vercel does not currently list this deployment as a rollback candidate. DevPilot will
            still send the request if you ask, but Vercel may refuse it.
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <code className="text-muted-foreground font-mono">{r.vercelDeploymentId}</code>
        {eligibility.eligible ? (
          <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={onPick}>
            <RotateCcw className="mr-1.5 h-3 w-3" /> Roll back to this
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="ml-auto" disabled>
            {planGated ? "Requires Pro" : "Unavailable"}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * The rollback confirm.
 *
 * Carries the three documented footguns verbatim from `ROLLBACK_WARNINGS`. They
 * are here rather than on the card because this is the moment the operator can
 * still change their mind, and each one is something a rollback does NOT undo —
 * the sort of thing nobody discovers until it bites.
 */
function ConfirmDialog({
  target,
  warnings,
  busy,
  onOpenChange,
  onConfirm,
}: {
  target: RollbackTarget | null;
  warnings: readonly string[];
  busy: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (deploymentId: string, confirmDeploymentId: string) => void | Promise<void>;
}) {
  const [typed, setTyped] = React.useState("");
  const id = target?.record.vercelDeploymentId ?? "";

  React.useEffect(() => {
    setTyped("");
  }, [id]);

  const armed = typed.trim().length > 0 && typed.trim() === id;

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Roll production back</DialogTitle>
        <DialogDescription>
          This repoints the production domain at an earlier build. It takes effect immediately for
          everyone using the site, with no rebuild and no review step.
        </DialogDescription>

        <div className="space-y-3 py-2 text-sm">
          <div className="text-xs">
            <div className="text-muted-foreground">Rolling back to</div>
            <code className="font-mono font-medium">{id}</code>
            {target?.record.branch ? (
              <span className="text-muted-foreground">
                {" "}
                · <code className="font-mono">{target.record.branch}</code>
              </span>
            ) : null}
          </div>

          <ul className="border-warning/40 bg-warning/10 space-y-1.5 rounded border px-2.5 py-2 text-xs">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <AlertTriangle className="text-warning mt-0.5 h-3 w-3 shrink-0" />
                <span>{w}</span>
              </li>
            ))}
          </ul>

          <label className="block space-y-1">
            <span className="text-xs font-medium">
              Type the deployment id <code className="font-mono">{id}</code> to confirm
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={id}
              className="font-mono"
              autoComplete="off"
            />
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!armed || busy}
            onClick={() => void onConfirm(id, typed.trim())}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Roll production back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The undo confirm.
 *
 * Also type-to-confirm: undoing is just as immediate a change to what live users
 * are served as the rollback was. The copy names the thing that actually makes
 * this urgent — undoing is what restores automatic production deploys.
 */
function UndoDialog({
  open,
  deploymentId,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  deploymentId: string | null;
  busy: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (confirmDeploymentId: string) => void | Promise<void>;
}) {
  const [typed, setTyped] = React.useState("");
  React.useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const id = deploymentId ?? "";
  const armed = typed.trim().length > 0 && typed.trim() === id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Undo the rollback</DialogTitle>
        <DialogDescription>
          Points production back at the deployment it was rolled away from, and restores
          Vercel&apos;s automatic assignment of production domains — so pushes to the production
          branch start going live again.
        </DialogDescription>

        <div className="space-y-3 py-2 text-sm">
          <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
            <CheckCircle2 className="text-success mt-0.5 h-3 w-3 shrink-0" />
            <span>
              DevPilot does this by <em>promoting</em> that deployment, which is what Vercel&apos;s
              own documentation prescribes. Vercel occasionally refuses to promote a deployment it
              has already promoted; if that happens, roll back to it from the list instead.
            </span>
          </p>

          <label className="block space-y-1">
            <span className="text-xs font-medium">
              Type <code className="font-mono">{id}</code> to confirm
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={id}
              className="font-mono"
              autoComplete="off"
            />
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={!armed || busy} onClick={() => void onConfirm(typed.trim())}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Undo rollback
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatWhen(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
