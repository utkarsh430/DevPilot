"use client";

// The per-agent model control, shared by `/scoreboard`'s Model column and the
// `/agents` gallery card.
//
// ── Why a popover, and why it EXPANDS ──────────────────────────────────────
// An agent is tenant-wide; a model was originally settable only per project. So
// "set this agent's model" had as many answers as the agent has projects, and
// the honest control was a per-project sub-list — never a single select that
// silently picks one project.
//
// ── The "All projects" section, and the trap it defuses ────────────────────
// A per-project list alone made the common case tedious: one select and one
// Apply per project, repeated for a workspace's worth of boards, and still
// silent about projects created LATER. The agent-wide default (an
// `agent_project_models` row with a NULL project_id) is the "set it once" case
// and sits at the TOP.
//
// It does NOT clear per-project rows — those still win (agent+project »
// agent-global). That is the trap: set the global to Opus, leave one project
// pinned to Sonnet, and it reads as "the global didn't work". So the section
// STATES how many projects override it and offers a named one-click clear.
// Silently deleting the operator's per-project choices to make the global look
// effective is precisely the surprise this family of work exists to end.
//
// The scoreboard's rows are `text-xs` with 11-13 columns inside a horizontally
// scrolling table, so an inline select + Apply cannot fit; the trigger is the
// summary label the cell showed before, and the list lives in the popover
// (precedent: components/roles/role-select.tsx).
//
// ── A model that is not in effect renders as not in effect ─────────────────
// Each row states what actually runs, via the shared `viewEffectiveModel`. A
// project that cannot serve Claude at all is inert with its reason shown, and a
// stored-but-shadowed value is labelled as not applying rather than as the
// agent's model — the failure this whole feature exists to end.

import * as React from "react";
import { ChevronsUpDown, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import {
  clearAgentProjectModelOverridesAction,
  setAgentGlobalModelAction,
  setAgentProjectModelAction,
} from "@/lib/metrics/model-actions";
import type { AgentGlobalTarget, AgentModelTarget } from "@/lib/metrics/agent-model-view";
import { ModelPicker, ladderLabel } from "./model-picker";

export type AgentModelControlProps = {
  roleSlug: string;
  displayName: string;
  targets: AgentModelTarget[];
  /** The agent-wide default + which of `targets` override it. */
  globalTarget: AgentGlobalTarget;
  /** `cell` = the scoreboard's Model column; `card` = the agents gallery. */
  variant?: "cell" | "card";
};

/**
 * The summary shown on the trigger: one label, or the honest "Mixed".
 *
 * The scoreboard cell gets the COMPACT form. This column sits in a 13-column
 * table, so every extra character here is width taken from the mistake counts;
 * the full per-project breakdown is one click away and is also in the trigger's
 * tooltip and accessible name, so nothing is lost by not spelling it out inline.
 */
function summaryOf(
  targets: AgentModelTarget[],
  globalValue: string,
  compact: boolean,
): { label: string; muted: boolean; title: string } {
  if (targets.length === 0) {
    // Not "nothing to configure" any more: the agent-wide default applies to
    // every project including ones added later, so the control stays live — and
    // with no project provider to shadow it, the stored global IS what runs.
    return {
      label: ladderLabel(globalValue),
      muted: globalValue === "",
      title: "This agent's default model, applied to every project.",
    };
  }
  const labels = [...new Set(targets.map((t) => t.effect.label))].sort();
  if (labels.length > 1) {
    return {
      label: compact ? `Mixed · ${targets.length}` : `Mixed (${targets.length} projects)`,
      muted: false,
      title: `${targets.length} projects: ${labels.join(" · ")}`,
    };
  }
  const only = targets[0]!;
  return {
    label: labels[0]!,
    // Anything that is not an in-effect pinned model reads muted, so a live
    // choice is visually distinct from an inherited or ignored one.
    muted: only.effect.state !== "pinned",
    title: only.effect.note ?? labels[0]!,
  };
}

export function AgentModelControl({
  roleSlug,
  displayName,
  targets,
  globalTarget,
  variant = "cell",
}: AgentModelControlProps) {
  const [open, setOpen] = React.useState(false);
  const summary = summaryOf(targets, globalTarget.currentValue, variant === "cell");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title={summary.title}
          aria-label={`Model for ${displayName}`}
          className={cn(
            "h-auto max-w-full justify-between gap-1.5 px-1.5 py-1 font-normal",
            variant === "cell" ? "text-[10px]" : "w-full justify-start text-[11px]",
            summary.muted && "text-muted-foreground",
          )}
        >
          {variant === "card" && (
            <>
              <Cpu className="h-3 w-3 shrink-0 opacity-70" />
              <span className="text-muted-foreground shrink-0">Model</span>
            </>
          )}
          <span className={cn("truncate", variant === "card" && "flex-1 text-left")}>
            {summary.label}
          </span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // Bounded by the space Radix measures to the viewport edge, so a tenant
        // with many projects scrolls inside the popover instead of running off
        // the bottom of the page.
        className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-[24rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
        align="start"
        sideOffset={6}
        collisionPadding={16}
      >
        <div className="border-b px-3 py-2">
          <p className="text-xs font-medium">Model for {displayName}</p>
          <p className="text-muted-foreground mt-0.5 text-[11px] leading-relaxed">
            Set one model for every project, or override it per project below. A project&rsquo;s own
            setting always wins.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <GlobalRow roleSlug={roleSlug} displayName={displayName} target={globalTarget} />
          {targets.length > 0 && (
            <p className="text-muted-foreground bg-muted/40 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide">
              Per project
            </p>
          )}
          {targets.map((target) => (
            <TargetRow
              key={target.projectId}
              roleSlug={roleSlug}
              displayName={displayName}
              target={target}
              hasGlobal={globalTarget.currentValue !== ""}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The agent-wide default.
 *
 * The picker itself stays scope-agnostic — it is handed `currentValue` and an
 * `onApply` and knows nothing about global-vs-project. Everything that makes
 * this row "the global" is copy and the override disclosure, right here.
 */
function GlobalRow({
  roleSlug,
  displayName,
  target,
}: {
  roleSlug: string;
  displayName: string;
  target: AgentGlobalTarget;
}) {
  const [clearError, setClearError] = React.useState<string | null>(null);
  const [cleared, setCleared] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const overriding = target.overriding;

  function clearOverrides() {
    setClearError(null);
    startTransition(async () => {
      const result = await clearAgentProjectModelOverridesAction({
        roleSlug,
        projectIds: overriding.map((p) => p.projectId),
      });
      if (result.ok) setCleared(true);
      else setClearError(result.error);
    });
  }

  return (
    <div className="bg-muted/20 flex flex-col gap-2 border-b p-3">
      <div className="min-w-0">
        <div className="text-xs font-medium">All projects</div>
        <div className="text-muted-foreground text-[11px]">
          This agent&rsquo;s default, including projects added later.
        </div>
      </div>
      <ModelPicker
        id={`agent-model-${roleSlug}-all`}
        currentValue={target.currentValue}
        ariaLabel={`Model for ${displayName} on all projects`}
        stacked
        savedMessage="Saved. New runs on every project use it, unless a project overrides it below."
        onApply={(model) =>
          setAgentGlobalModelAction({ roleSlug, model: model === "" ? null : model })
        }
        renderPreview={(next) => (
          <>
            <strong>{displayName}</strong> will run on <strong>{ladderLabel(next)}</strong> across
            every project
            {next === "" && " — inheriting each project's own model"}. Projects with their own
            setting below keep it.
          </>
        )}
      />
      {overriding.length > 0 && !cleared && (
        // The trap, stated. Never resolved by deleting his choices for him.
        <div className="border-warning/40 bg-warning/5 flex flex-col gap-1.5 rounded-md border p-2">
          <p className="text-[11px] leading-relaxed">
            {overriding.length === 1
              ? "1 project overrides this and keeps its own model:"
              : `${overriding.length} projects override this and keep their own model:`}{" "}
            <span className="text-muted-foreground">
              {overriding.map((p) => p.projectName).join(", ")}
            </span>
          </p>
          <div>
            <Button size="sm" variant="outline" onClick={clearOverrides} disabled={pending}>
              {pending
                ? "Clearing…"
                : `Clear ${overriding.length} project override${overriding.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      )}
      {cleared && (
        <p className="text-success text-[11px]">
          Cleared. Those projects now use this agent&rsquo;s default.
        </p>
      )}
      {clearError && <p className="text-destructive text-[11px]">{clearError}</p>}
    </div>
  );
}

function TargetRow({
  roleSlug,
  displayName,
  target,
  hasGlobal,
}: {
  roleSlug: string;
  displayName: string;
  target: AgentModelTarget;
  hasGlobal: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 border-b p-3 last:border-0">
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-xs font-medium">{target.projectName}</span>
          {hasGlobal && (
            <span
              className={cn(
                "shrink-0 text-[10px]",
                target.hasOwnRow ? "text-warning" : "text-muted-foreground",
              )}
            >
              {target.hasOwnRow ? "overrides default" : "inherits default"}
            </span>
          )}
        </div>
        <div className="text-muted-foreground text-[11px]">
          Runs on:{" "}
          <span
            className={cn(
              "font-medium",
              target.effect.state === "pinned" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {target.effect.label}
          </span>
          {target.effect.state === "not_in_effect" && (
            <span className="text-warning"> · not in effect</span>
          )}
        </div>
        {target.effect.note && (
          <p className="text-muted-foreground mt-1 text-[10px] leading-relaxed">
            {target.effect.note}
          </p>
        )}
      </div>
      <ModelPicker
        id={`agent-model-${roleSlug}-${target.projectId}`}
        currentValue={target.currentValue}
        ariaLabel={`Model for ${displayName} on ${target.projectName}`}
        disabled={!target.offerable}
        disabledReason={target.disabledReason}
        stacked
        savedMessage="Saved. New runs on this project use it."
        onApply={(model) =>
          setAgentProjectModelAction({
            projectId: target.projectId,
            roleSlug,
            model: model === "" ? null : model,
          })
        }
        renderPreview={(next) => (
          <>
            <strong>{displayName}</strong> will run on <strong>{ladderLabel(next)}</strong> for{" "}
            <strong>{target.projectName}</strong>
            {next === "" &&
              (hasGlobal
                ? " — inheriting this agent's all-projects default"
                : " — inheriting the project's own model")}
            . Other agents on this project are unaffected.
          </>
        )}
      />
    </div>
  );
}
