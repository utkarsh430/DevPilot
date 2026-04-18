"use client";

// The deploy surface: trigger a build, watch it, and see what happened.
//
// ── Two buttons, not one button with a switch ─────────────────────────────
// Preview and production are separate controls calling separate server actions,
// and they are deliberately not visually equivalent. Preview is the default
// action and reads as routine. Production is set apart, is styled as
// destructive, and opens a type-to-confirm dialog in which the operator types
// the exact ref — the `discardAndRestartFromDevAction` precedent, applied
// because a production deploy is publishing: live immediately, externally
// visible, not reviewable after the fact.
//
// The requirement being met here is that a misclick cannot ship to production.
// A shared button with a target toggle fails that requirement no matter how the
// toggle is labelled, which is why there are two actions all the way down to the
// request body (`specCreateDeployment` omits `target` entirely for a preview).
//
// ── The failure surface is the reason the list exists ─────────────────────
// A failed build renders inline, in red, with its Vercel build-log link as a
// first-class control — not a tooltip, not "see the dashboard". "Deploy failed"
// with no route to the log is a dead end, and it is the state an operator is
// most likely to be looking at when they open this card.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  Loader2,
  Rocket,
  ScrollText,
  ShieldAlert,
  XCircle,
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
import { classifyDeployState, deployPhaseLabel, type DeployPhase } from "@/lib/vercel/deploy-state";
import type { DeploymentRecord } from "@/lib/vercel/deploy-write";
import {
  deployPreviewAction,
  deployProductionAction,
  listProjectDeploymentsAction,
} from "./vercel-actions";

export type DeploySectionProps = {
  projectId: string;
  /** The ref both controls default to — the integration branch, where auto-land
   *  puts completed work. */
  defaultRef: string;
  /** Vercel's live production branch, for the confirm copy. Null when unread. */
  productionBranch: string | null;
  /** Seeded server-side so the list is populated on first paint. */
  initial: DeploymentRecord[];
};

const PHASE_ICON: Record<DeployPhase, React.ElementType> = {
  ready: CheckCircle2,
  error: XCircle,
  canceled: AlertTriangle,
  pending: Loader2,
  unknown: CircleDashed,
};

const PHASE_CLASS: Record<DeployPhase, string> = {
  ready: "text-success",
  error: "text-destructive",
  canceled: "text-warning",
  pending: "text-muted-foreground animate-spin",
  unknown: "text-warning",
};

export function DeploySection(props: DeploySectionProps) {
  const router = useRouter();
  const [rows, setRows] = React.useState<DeploymentRecord[]>(props.initial);
  const [busy, setBusy] = React.useState(false);
  const [prodOpen, setProdOpen] = React.useState(false);

  const hasPending = rows.some((r) => !classifyDeployState(r.readyState).terminal);

  const refresh = React.useCallback(async () => {
    const res = await listProjectDeploymentsAction(props.projectId);
    if (res.ok) setRows(res.value);
  }, [props.projectId]);

  // While a build is in flight the durable poller is updating the ledger behind
  // us, so the card polls its own list. It stops the moment nothing is pending —
  // an idle card must not sit there making requests forever.
  React.useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [hasPending, refresh]);

  async function run(fn: () => ReturnType<typeof deployPreviewAction>, label: string) {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return false;
      }
      // A warning alongside a success is not decoration — it is the case where
      // the deploy ran but DevPilot's production surface is in a state the
      // operator has not resolved. Surfaced as its own toast so it cannot be
      // read as part of the success line.
      toast.success(label);
      if (res.warning) toast.warning(res.warning, { duration: 12_000 });
      await refresh();
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Deploy</p>
          <p className="text-muted-foreground text-xs">
            Builds <code className="font-mono">{props.defaultRef}</code>. DevPilot watches the build
            and records the result here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(
                () => deployPreviewAction({ projectId: props.projectId }),
                "Preview deploy started.",
              )
            }
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="mr-1.5 h-3.5 w-3.5" />
            )}
            Deploy preview
          </Button>
          {/* Set apart deliberately: destructive styling and its own dialog, so
              production is never one click away from the routine action. */}
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => setProdOpen(true)}>
            <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
            Deploy to production…
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">No deployments from DevPilot yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((r) => (
            <DeploymentRow key={r.id || r.vercelDeploymentId} row={r} />
          ))}
        </ul>
      )}

      <ProductionDialog
        open={prodOpen}
        onOpenChange={setProdOpen}
        defaultRef={props.defaultRef}
        productionBranch={props.productionBranch}
        busy={busy}
        onConfirm={async (ref, confirmRef) => {
          const ok = await run(
            () => deployProductionAction({ projectId: props.projectId, ref, confirmRef }),
            "Production deploy started.",
          );
          if (ok) setProdOpen(false);
        }}
      />
    </div>
  );
}

function DeploymentRow({ row }: { row: DeploymentRecord }) {
  const cls = classifyDeployState(row.readyState);
  const Icon = PHASE_ICON[cls.phase];
  const failed = cls.phase === "error";

  return (
    <li className="space-y-1.5 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${PHASE_CLASS[cls.phase]}`} />
        <Badge tone={row.target === "production" ? "danger" : "muted"}>
          {row.target === "production" ? "Production" : "Preview"}
        </Badge>
        <span className="font-medium">{deployPhaseLabel(cls.phase)}</span>
        {row.branch ? <code className="text-muted-foreground font-mono">{row.branch}</code> : null}
        {row.commitSha ? (
          <code className="text-muted-foreground font-mono">{row.commitSha.slice(0, 7)}</code>
        ) : null}
        <span className="text-muted-foreground ml-auto">{formatWhen(row.createdAt)}</span>
      </div>

      {/* Vercel's own words for an unrecognised state, rather than DevPilot's
          guess at what it means. */}
      {cls.phase === "unknown" && row.readyState ? (
        <p className="text-muted-foreground">
          Vercel reports <code className="font-mono">{row.readyState}</code>, which DevPilot does
          not recognise.
        </p>
      ) : null}

      {failed && row.errorMessage ? (
        <p className="border-destructive/40 bg-destructive/10 rounded border px-2 py-1.5">
          {row.errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {row.url && cls.phase === "ready" ? (
          <a
            className="text-primary inline-flex items-center gap-1 hover:underline"
            href={row.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLink className="h-3 w-3" /> Open
          </a>
        ) : null}
        {/* The build log is a first-class control on a failure, and emphasised
            there — this is the operator's only route from "it failed" to why. */}
        {row.inspectorUrl ? (
          <a
            className={`inline-flex items-center gap-1 hover:underline ${
              failed ? "text-destructive font-medium" : "text-muted-foreground"
            }`}
            href={row.inspectorUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ScrollText className="h-3 w-3" /> {failed ? "Open build log" : "Build log"}
          </a>
        ) : failed ? (
          <span className="text-muted-foreground">
            No build log link — find this deployment on the Vercel dashboard.
          </span>
        ) : null}
        <code className="text-muted-foreground ml-auto font-mono">{row.vercelDeploymentId}</code>
      </div>
    </li>
  );
}

/**
 * The production confirm.
 *
 * The operator types the ref. Not a checkbox: a checkbox confirms a LABEL, and a
 * later edit could leave that label describing a different branch than the
 * request carries. Typing the ref means the thing confirmed is the thing that
 * ships — and the server re-checks it independently (`decideProductionDeployGate`),
 * so this dialog is the ergonomics, not the gate.
 */
function ProductionDialog({
  open,
  onOpenChange,
  defaultRef,
  productionBranch,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultRef: string;
  productionBranch: string | null;
  busy: boolean;
  onConfirm: (ref: string, confirmRef: string) => void | Promise<void>;
}) {
  const [ref, setRef] = React.useState(defaultRef);
  const [typed, setTyped] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setRef(defaultRef);
      setTyped("");
    }
  }, [open, defaultRef]);

  const armed = typed.trim().length > 0 && typed.trim() === ref.trim();
  const offProductionBranch =
    productionBranch !== null && ref.trim().length > 0 && ref.trim() !== productionBranch;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Deploy to production</DialogTitle>
        <DialogDescription>
          This goes live immediately on the production domain. There is no review step and no
          approval gate after this dialog.
        </DialogDescription>

        <div className="space-y-3 py-2 text-sm">
          <label className="block space-y-1">
            <span className="text-xs font-medium">Branch or ref to deploy</span>
            <Input value={ref} onChange={(e) => setRef(e.target.value)} className="font-mono" />
          </label>

          {productionBranch === null ? (
            <p className="border-warning/40 bg-warning/10 rounded border px-2 py-1.5 text-xs">
              DevPilot could not read which branch Vercel currently deploys production from, so it
              cannot tell you whether this project&apos;s production settings are what you expect.
              The deploy still ships exactly the ref above.
            </p>
          ) : offProductionBranch ? (
            <p className="border-warning/40 bg-warning/10 rounded border px-2 py-1.5 text-xs">
              Vercel&apos;s production branch is{" "}
              <code className="font-mono">{productionBranch}</code>. Deploying{" "}
              <code className="font-mono">{ref}</code> puts it live now, but the next push to{" "}
              <code className="font-mono">{productionBranch}</code> will replace it.
            </p>
          ) : null}

          <label className="block space-y-1">
            <span className="text-xs font-medium">
              Type <code className="font-mono">{ref}</code> to confirm
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={ref}
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
            onClick={() => void onConfirm(ref.trim(), typed.trim())}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Deploy {ref} to production
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
