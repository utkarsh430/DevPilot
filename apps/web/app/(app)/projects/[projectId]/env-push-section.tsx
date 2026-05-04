"use client";

// The env-var push surface: show the plan, THEN act.
//
// ── Why the plan is a screen and not a spinner ─────────────────────────────
// The list of variables a project needs comes from `.env.example`, a file agents
// can edit. DevPilot only ever pushes names it ALSO holds a human-supplied value
// for (see `lib/vercel/env-plan.ts`), so an edited `.env.example` cannot move a
// value on its own — but it can put a NAME in front of the operator. This screen
// is where that name has to be visible. A push that silently included a
// newly-appeared variable would be the failure mode; a first-seen name is
// therefore lifted into its own callout above everything else, not sorted into
// the middle of a list of eight familiar ones.
//
// Three groups, always rendered in this order and never collapsed by default:
//
//   Will push        — declared by the repo AND held in DevPilot's vault.
//   Needs a value    — declared but not held. Collected here, by hand.
//   Already on Vercel — present and not written by DevPilot. LEFT ALONE unless
//                      the operator ticks it, because silently overwriting a
//                      value somebody set in the Vercel dashboard is a bad
//                      surprise and DevPilot cannot even read it to compare.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Sparkles,
  Upload,
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
import { toast } from "@/components/ui/sonner";
import { SecretValuesForm } from "@/components/secrets/SecretValuesForm";
import { ENV_PUSH_TARGETS, type EnvPushPlan } from "@/lib/vercel/env-plan";
import { planVercelEnvPushAction, pushVercelEnvAction } from "./vercel-actions";

const PUSH_REASON_LABEL: Record<EnvPushPlan["push"][number]["reason"], string> = {
  create: "new on Vercel",
  update_managed: "replacing the value DevPilot set before",
  extend_targets: "adding missing production/preview targets",
  operator_override: "overwriting a value you did not set — you ticked this",
};

const LEAVE_REASON_LABEL: Record<EnvPushPlan["leave"][number]["reason"], string> = {
  identical: "already matches the value DevPilot holds",
  foreign_unreadable: "set outside DevPilot — DevPilot cannot read it back to compare",
  foreign_differs: "set outside DevPilot and the value differs from DevPilot's",
};

export function EnvPushSection({
  projectId,
  vercelProjectName,
}: {
  projectId: string;
  vercelProjectName: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [pushing, setPushing] = React.useState(false);
  const [plan, setPlan] = React.useState<EnvPushPlan | null>(null);
  const [remoteError, setRemoteError] = React.useState<string | null>(null);
  const [overrides, setOverrides] = React.useState<string[]>([]);

  const load = React.useCallback(
    async (nextOverrides: string[]) => {
      setLoading(true);
      const res = await planVercelEnvPushAction({ projectId, overrides: nextOverrides });
      setLoading(false);
      if (!res.ok) {
        toast.error(res.error);
        setPlan(null);
        return;
      }
      setPlan(res.value.plan);
      setRemoteError(res.value.remoteError);
    },
    [projectId],
  );

  function openDialog() {
    setOverrides([]);
    setPlan(null);
    setRemoteError(null);
    setOpen(true);
    void load([]);
  }

  function toggleOverride(key: string) {
    const next = overrides.includes(key) ? overrides.filter((k) => k !== key) : [...overrides, key];
    setOverrides(next);
    void load(next);
  }

  async function confirmPush() {
    setPushing(true);
    const res = await pushVercelEnvAction({ projectId, overrides });
    setPushing(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (res.warning) {
      toast.warning("Pushed with problems", { description: res.warning, duration: 30_000 });
    } else {
      toast.success(
        `Pushed ${res.value.pushed.length} variable${res.value.pushed.length === 1 ? "" : "s"} to Vercel.`,
      );
    }
    await load(overrides);
    router.refresh();
  }

  const firstSeen = plan?.ask.filter((a) => a.firstSeen) ?? [];

  return (
    <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="text-muted-foreground h-3.5 w-3.5" />
          Environment variables
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Push the values DevPilot already holds for this project to{" "}
          {vercelProjectName ? <code>{vercelProjectName}</code> : "the linked Vercel project"}, for{" "}
          <strong>{ENV_PUSH_TARGETS.join(" and ")}</strong>. DevPilot shows you exactly what it
          would write before writing anything.
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={openDialog} className="shrink-0">
        <Upload className="h-3 w-3" /> Review &amp; push
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>Environment variables → Vercel</DialogTitle>
          <DialogDescription>
            Nothing is written until you press Push. Values are sent as Vercel{" "}
            <strong>sensitive</strong> variables, which Vercel makes non-readable after creation and
            redacts from build logs.
          </DialogDescription>

          <div className="mt-4 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {loading && !plan ? (
              <p className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading Vercel and your vault…
              </p>
            ) : !plan ? (
              <p className="text-muted-foreground py-6 text-sm">No plan could be built.</p>
            ) : (
              <>
                {remoteError ? (
                  <Callout tone="warn" icon={AlertTriangle} title="Could not read Vercel">
                    {remoteError} The plan below was built from your vault alone, so everything
                    reads as new. Pushing is still safe — DevPilot upserts — but it cannot tell you
                    what is already there.
                  </Callout>
                ) : null}

                {/* The untrusted-input callout. Deliberately FIRST and
                    deliberately not collapsible. */}
                {firstSeen.length > 0 ? (
                  <Callout tone="warn" icon={Sparkles} title="New variable names">
                    {firstSeen.length === 1 ? "This name has" : "These names have"} never been seen
                    before on this project — not in DevPilot&apos;s vault, not on Vercel. This list
                    is parsed from the repository&apos;s <code>.env.example</code>, which agents can
                    edit. DevPilot will not push anything for{" "}
                    {firstSeen.length === 1 ? "it" : "them"} unless you type a value in below.
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {firstSeen.map((a) => (
                        <Badge key={a.key} tone="warn" className="font-mono text-[10px]">
                          {a.key}
                        </Badge>
                      ))}
                    </div>
                  </Callout>
                ) : null}

                <Group
                  title="Will push"
                  count={plan.push.length}
                  empty="Nothing to push — every declared variable is either missing a value or already set on Vercel."
                >
                  {plan.push.map((p) => (
                    <Row key={p.key} keyName={p.key} note={PUSH_REASON_LABEL[p.reason]}>
                      {p.required ? (
                        <Badge tone="muted" className="text-[10px]">
                          required
                        </Badge>
                      ) : null}
                    </Row>
                  ))}
                </Group>

                <Group
                  title="Needs a value"
                  count={plan.ask.length}
                  empty="DevPilot holds a value for every variable the repo declares."
                >
                  <p className="text-muted-foreground mb-2 text-xs">
                    DevPilot has no value for these, so it cannot push them. Enter them here and
                    they are stored in this project&apos;s vault — the same place the runner reads
                    from — then re-run the plan.
                  </p>
                  <div className="space-y-1.5">
                    {plan.ask.map((a) => (
                      <Row
                        key={a.key}
                        keyName={a.key}
                        note={a.description ?? (a.required ? "required" : "optional")}
                      >
                        {a.firstSeen ? (
                          <Badge tone="warn" className="text-[10px]">
                            new
                          </Badge>
                        ) : null}
                      </Row>
                    ))}
                  </div>
                  {plan.ask.length > 0 ? (
                    <div className="mt-3 border-t pt-3">
                      <SecretValuesForm
                        projectId={projectId}
                        keys={plan.ask.map((a) => a.key)}
                        descriptions={Object.fromEntries(
                          plan.ask.map((a) => [a.key, a.description]),
                        )}
                        submitLabel="Save values"
                        footerNote="encrypted at rest · stays in DevPilot until you push"
                        onSaved={() => load(overrides)}
                      />
                    </div>
                  ) : null}
                </Group>

                <Group
                  title="Already on Vercel"
                  count={plan.leave.length}
                  empty="Nothing declared is already set on Vercel."
                >
                  <p className="text-muted-foreground mb-2 text-xs">
                    DevPilot leaves these alone. It did not write them, and for a{" "}
                    <strong>sensitive</strong> variable it cannot read the value back to compare, so
                    overwriting one is your call and not a default.
                  </p>
                  <div className="space-y-1.5">
                    {plan.leave.map((l) => (
                      <Row key={l.key} keyName={l.key} note={LEAVE_REASON_LABEL[l.reason]}>
                        {l.overridable ? (
                          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px]">
                            <input
                              type="checkbox"
                              checked={overrides.includes(l.key)}
                              onChange={() => toggleOverride(l.key)}
                              disabled={loading || pushing}
                            />
                            overwrite
                          </label>
                        ) : (
                          <CheckCircle2 className="text-success h-3.5 w-3.5 shrink-0" />
                        )}
                      </Row>
                    ))}
                  </div>
                </Group>

                {plan.extra.length > 0 ? (
                  <Callout tone="muted" icon={Lock} title="Held but not declared">
                    DevPilot holds {plan.extra.length} value
                    {plan.extra.length === 1 ? "" : "s"} the repo does not declare in{" "}
                    <code>.env.example</code>. These are <strong>not</strong> pushed — widening the
                    deployed app&apos;s environment with runner-only keys is not something to do by
                    accident.
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {plan.extra.map((k) => (
                        <Badge key={k} tone="muted" className="font-mono text-[10px]">
                          {k}
                        </Badge>
                      ))}
                    </div>
                  </Callout>
                ) : null}
              </>
            )}
          </div>

          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => void load(overrides)}
              disabled={loading || pushing}
            >
              <RefreshCw className="h-3 w-3" /> Re-check
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pushing}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void confirmPush()}
              disabled={pushing || loading || !plan || plan.push.length === 0}
            >
              {pushing
                ? "Pushing…"
                : `Push ${plan?.push.length ?? 0} variable${(plan?.push.length ?? 0) === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** `count` is passed EXPLICITLY rather than inferred from `children`. Inferring
 *  it was wrong for any group whose body includes explanatory prose alongside
 *  the list — React sees a non-empty subtree and renders an empty list under a
 *  heading that says "(0)", instead of the sentence that explains why there is
 *  nothing there. */
function Group({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider">
        {title} ({count})
      </h4>
      {count > 0 ? children : <p className="text-muted-foreground text-xs">{empty}</p>}
    </section>
  );
}

function Row({
  keyName,
  note,
  children,
}: {
  keyName: string;
  note: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <code className="shrink-0 font-mono text-[11px] font-medium">{keyName}</code>
        <span className="text-muted-foreground truncate">{note}</span>
      </div>
      {children}
    </div>
  );
}

function Callout({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: "warn" | "muted";
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        tone === "warn" ? "border-warning/40 bg-warning/10" : "bg-muted/40"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "warn" ? "text-warning" : "text-muted-foreground"}`}
        />
        <div className="min-w-0 text-xs">
          <p className="mb-1 text-sm font-medium">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
