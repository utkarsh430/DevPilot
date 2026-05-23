"use client";

// The stack advisor's editing body — the ecosystem grid, the essential-vs-optional
// density split, per-capability option cards, the add-capability / advanced
// disclosures, and the save/skip footer.
//
// Phase 3 of the plan-component revamp reshapes the flat "every included
// capability is a full card" render into THREE presentation bands, driven by
// per-suggestion signals that already exist (`confidence`, the capability's
// `baseline` flag) plus a local density dial defaulted from the team tier:
//
//   • Essential   — `confidence >= 8 && !baseline` — full 3-option cards.
//   • Recommended — `baseline || (5 <= confidence < 8)` — folded into ONE
//                   pre-ticked "Production baseline" group (dashed border =
//                   "assumed, not deliberated"), expandable to full cards.
//   • Optional    — `confidence < 5` — the low-confidence entries, now folded
//                   (low-confidence first) into the single "Add more
//                   capabilities" disclosure.
//
// LOAD-BEARING INVARIANT (presentation only): the dial and the bands change how
// prominently a capability is SHOWN, never whether it is SAVED. `includedCapabilities`
// / `overrides` / `selectedByCapability` — the inputs `handleSave` reads — are
// untouched by anything in this file (they live in `use-stack-advisor.tsx`), and
// the baseline floor stays in `normalizeSuggestions`. So Recommended/baseline
// capabilities remain pre-ticked and in the saved set, `stackTagsBlock` renders a
// complete frame, and switching the dial never changes what Save writes. The
// per-row `X` remove and the merged add-capability list are the fine-grained
// escape hatches ON TOP of the coarse dial.
//
// Presentational only: every piece of state and every handler comes in through
// the `advisor` object (and the read-only `teamTier` view-default).

import * as React from "react";
import { AlertTriangle, ChevronDown, Loader2, Plus, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { EcosystemPicker } from "@/components/stack/EcosystemPicker";
import { StackTagPicker } from "@/components/stack/StackTagPicker";
import type { CapabilityKey } from "@/lib/stack/capabilities";
import { rankCapability, type CapabilityPlan, type RankedOption } from "@/lib/stack/rank";
import {
  getServiceEntry,
  servicesForCapability,
  type ServiceCatalogEntry,
} from "@/lib/stack/service-catalog";
import {
  bandForPlan,
  defaultDensityForTier,
  isFullCard,
  type DensityView,
} from "@/lib/stack/density";
import { DEFAULT_TEAM_TIER, type TeamTier } from "@/lib/team-tiers/tiers";
import type { StackAdvisor } from "@/components/stack/use-stack-advisor";

const PROVIDER_LABEL: Record<ServiceCatalogEntry["provider"], string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "Google Cloud",
  oss: "Open source",
};

export function providerChip(service: ServiceCatalogEntry): string {
  if (service.provider === "oss") return service.managed ? "3rd-party managed" : "Open source";
  return PROVIDER_LABEL[service.provider];
}

export function StackAdvisorBody({
  advisor,
  teamTier = DEFAULT_TEAM_TIER,
}: {
  advisor: StackAdvisor;
  /** Read-only. Seeds the density dial's DEFAULT view; never mutated here. */
  teamTier?: TeamTier;
}) {
  const {
    sessionId,
    status,
    ecosystem,
    setEcosystem,
    extraServiceKeys,
    setExtraServiceKeys,
    running,
    saving,
    degraded,
    degradedReason,
    plans,
    maybeAlso,
    suggestionByKey,
    addable,
    handleRun,
    handleSave,
    handleSkip,
    handleReopen,
  } = advisor;

  // Density dial — a LOCAL view control, defaulted from the team tier.
  const [view, setView] = React.useState<DensityView>(() => defaultDensityForTier(teamTier));
  // The "Production baseline" group's escape hatch: reveal the folded rows as
  // full cards without leaving the current view.
  const [baselineExpanded, setBaselineExpanded] = React.useState(false);

  // Split included capabilities into full-card vs folded, off the confidence +
  // baseline signals + the dial. Pure re-partition of `plans`; the saved set
  // (`includedCapabilities`) is never touched.
  const { fullCardPlans, foldedPlans } = React.useMemo(() => {
    const full: CapabilityPlan[] = [];
    const folded: CapabilityPlan[] = [];
    for (const plan of plans) {
      const band = bandForPlan(
        plan.capability.baseline,
        suggestionByKey.get(plan.capability.key)?.confidence,
      );
      if (isFullCard(band, plan.capability.key, view)) full.push(plan);
      else folded.push(plan);
    }
    return { fullCardPlans: full, foldedPlans: folded };
  }, [plans, suggestionByKey, view]);

  if (status === "skipped") {
    return (
      <div className="text-muted-foreground flex items-center justify-between gap-2 rounded-md border border-dashed p-4 text-xs">
        <span>Stack advisor skipped for this session.</span>
        <Button variant="outline" size="sm" onClick={handleReopen}>
          Reopen
        </Button>
      </div>
    );
  }

  if (status === "unrun" || (running && advisor.suggestions.length === 0)) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-md border border-dashed p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground text-xs">
          {running
            ? "Thinking…"
            : "Get a ranked, ecosystem-aware set of services for this project. Nothing is saved until you review and confirm."}
        </p>
        <div className="flex items-center gap-2">
          {sessionId ? (
            <Button variant="ghost" size="sm" onClick={() => void handleSkip()} disabled={running}>
              Skip
            </Button>
          ) : null}
          <Button onClick={() => void handleRun()} disabled={running} size="sm">
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Suggest my stack
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Density dial — top of the body. Defaults from tier; local view only. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-[11px] font-medium">Show</span>
        <DensityDial view={view} onChange={setView} />
      </div>

      <EcosystemPicker value={ecosystem} onChange={setEcosystem} disabled={running} />

      {degraded ? (
        <div className="border-warning/30 bg-warning/5 text-warning rounded-md border px-3 py-2 text-[11px] leading-snug">
          <span className="font-medium">Couldn&apos;t reach the model</span> — showing a standard
          baseline instead. Edit it below.
          {degradedReason ? (
            <span className="text-muted-foreground block">{degradedReason}</span>
          ) : null}
        </div>
      ) : null}

      {/* Essential — full 3-option cards, expanded. The product's named needs. */}
      {fullCardPlans.length > 0 ? (
        <div className="space-y-3">
          {fullCardPlans.map((plan) => (
            <CapabilityFullCard key={plan.capability.key} advisor={advisor} plan={plan} />
          ))}
        </div>
      ) : null}

      {/* Recommended — one pre-ticked "Production baseline" group. Dashed border
          reads "assumed, not deliberated"; every row stays SAVED (pre-ticked),
          folding only changes prominence. Expandable to full cards. */}
      {foldedPlans.length > 0 ? (
        <div className="rounded-md border border-dashed p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-display text-sm font-medium">Production baseline</div>
              <div className="text-muted-foreground text-[11px]">
                {foldedPlans.length} sensible default{foldedPlans.length === 1 ? "" : "s"},
                pre-selected — assumed, not deliberated. Included in the plan either way.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setBaselineExpanded((v) => !v)}
              aria-expanded={baselineExpanded}
              className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-[11px]"
            >
              <ChevronDown
                className={cn("h-3 w-3 transition-transform", baselineExpanded && "rotate-180")}
              />
              {baselineExpanded ? "Hide" : "Customize"}
            </button>
          </div>

          {baselineExpanded ? (
            <div className="mt-3 space-y-3">
              {foldedPlans.map((plan) => (
                <CapabilityFullCard key={plan.capability.key} advisor={advisor} plan={plan} />
              ))}
            </div>
          ) : (
            <div className="mt-2 space-y-1">
              {foldedPlans.map((plan) => (
                <BaselineRow key={plan.capability.key} advisor={advisor} plan={plan} />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Add more capabilities — the merged disclosure (old "Maybe also" +
          "+ Add a capability"). Low-confidence (Optional, confidence < 5)
          entries first, each keeping the confidence/10 chip. */}
      <AddMoreCapabilities
        addable={addable}
        maybeAlso={maybeAlso}
        suggestionByKey={suggestionByKey}
        onAdd={advisor.addCapability}
      />

      {/* Advanced: extra services — the ONLY route to taxonomy-excluded services
          (payments/Stripe, iac/terraform). Kept last, subordinate, collapsed. */}
      <details className="rounded-md border p-3">
        <summary className="text-muted-foreground cursor-pointer text-[11px] font-medium">
          Advanced: extra services
        </summary>
        <div className="mt-2">
          <StackTagPicker
            selected={extraServiceKeys}
            onChange={setExtraServiceKeys}
            disabled={saving || running}
          />
        </div>
      </details>

      <div className="flex justify-end gap-2 border-t pt-3">
        {sessionId ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleSkip()}
            disabled={saving || running}
          >
            Skip
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void handleSave()} disabled={saving || running}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save stack
        </Button>
      </div>
    </div>
  );
}

function DensityDial({
  view,
  onChange,
}: {
  view: DensityView;
  onChange: (v: DensityView) => void;
}) {
  const OPTIONS: ReadonlyArray<{ value: DensityView; label: string }> = [
    { value: "essentials", label: "Essentials" },
    { value: "recommended", label: "Recommended" },
    { value: "everything", label: "Everything" },
  ];
  return (
    <div
      role="group"
      aria-label="Advisor density"
      className="bg-muted/60 inline-flex items-center rounded-md p-0.5 text-[11px]"
    >
      {OPTIONS.map((o) => {
        const active = view === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "rounded px-2.5 py-1 font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// One compact, pre-ticked row inside the "Production baseline" group: the
// capability, its selected service, and the per-row remove escape hatch.
function BaselineRow({ advisor, plan }: { advisor: StackAdvisor; plan: CapabilityPlan }) {
  const selected = advisor.selectedByCapability.get(plan.capability.key);
  const serviceName = selected ? (getServiceEntry(selected)?.displayName ?? selected) : null;
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-foreground/80 shrink-0 truncate font-medium">
          {plan.capability.displayName}
        </span>
        {serviceName ? (
          <>
            <span className="text-muted-foreground/50 shrink-0" aria-hidden>
              ·
            </span>
            <span className="text-muted-foreground truncate">{serviceName}</span>
          </>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => advisor.removeCapability(plan.capability.key)}
        className="text-muted-foreground hover:text-foreground shrink-0"
        title="Not needed"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// A single capability's full option-card block: header, the top-3 (plus the
// out-of-top-3 saved pick), a coherence warning, and the "show all N" expander.
// Extracted verbatim from the old inline render so both the Essential band and
// the expanded "Production baseline" group reuse it.
function CapabilityFullCard({ advisor, plan }: { advisor: StackAdvisor; plan: CapabilityPlan }) {
  const {
    ecosystem,
    selectedByCapability,
    pinnedByCapability,
    coherenceByCapability,
    expanded,
    toggleExpanded,
    removeCapability,
    selectOption,
  } = advisor;

  const selected = selectedByCapability.get(plan.capability.key);
  const pinned = pinnedByCapability.get(plan.capability.key);
  const warnings = coherenceByCapability.get(plan.capability.key) ?? [];
  const isExpanded = expanded.has(plan.capability.key);
  const allOptions: RankedOption[] = isExpanded
    ? rankCapability({
        capability: plan.capability.key,
        ecosystem,
        optionsPerCapability: servicesForCapability(plan.capability.key).length,
      })
    : [];

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{plan.capability.displayName}</div>
          <div className="text-muted-foreground text-[11px]">{plan.capability.purpose}</div>
        </div>
        <button
          type="button"
          onClick={() => removeCapability(plan.capability.key)}
          className="text-muted-foreground hover:text-foreground shrink-0"
          title="Not needed"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {plan.options.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-[11px] italic">
          No catalog options for this capability yet.
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            ...plan.options,
            // The saved/detected pick, when it ranks outside the top-3
            // — always rendered, never silently dropped.
            ...(pinned ? [pinned] : []),
          ].map((opt) => (
            <OptionCard
              key={opt.service.key}
              option={opt}
              checked={selected === opt.service.key}
              name={`stack-advisor-${plan.capability.key}`}
              onSelect={() => selectOption(plan.capability.key, opt.service.key)}
            />
          ))}
        </div>
      )}

      {warnings.length > 0 ? (
        <div className="border-warning/30 bg-warning/5 text-warning mt-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-snug">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{warnings[0]!.message}</span>
        </div>
      ) : null}

      {servicesForCapability(plan.capability.key).length > plan.options.length ? (
        <button
          type="button"
          onClick={() => toggleExpanded(plan.capability.key)}
          className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-[11px]"
        >
          <ChevronDown className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-180")} />
          {isExpanded
            ? "Hide options"
            : `Show all ${servicesForCapability(plan.capability.key).length} options`}
        </button>
      ) : null}

      {isExpanded ? (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {allOptions.map((opt) => (
            <OptionCard
              key={opt.service.key}
              option={opt}
              checked={selected === opt.service.key}
              name={`stack-advisor-${plan.capability.key}`}
              onSelect={() => selectOption(plan.capability.key, opt.service.key)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// The merged "Add more capabilities" list: the old "Maybe also (low
// confidence)" chips and the "+ Add a capability" chips collapsed into ONE
// disclosure, low-confidence (Optional) first, each keeping its confidence/10
// chip. Adding one puts it in the SAVED set (`addCapability`) exactly as before.
function AddMoreCapabilities({
  addable,
  maybeAlso,
  suggestionByKey,
  onAdd,
}: {
  addable: StackAdvisor["addable"];
  maybeAlso: StackAdvisor["maybeAlso"];
  suggestionByKey: StackAdvisor["suggestionByKey"];
  onAdd: (key: CapabilityKey) => void;
}) {
  // Low-confidence suggestions (Optional) sort to the front; catalog order is
  // preserved within each group by the stable sort.
  const maybeAlsoKeys = React.useMemo(() => new Set(maybeAlso.map((s) => s.key)), [maybeAlso]);
  const ordered = React.useMemo(
    () =>
      [...addable].sort((a, b) => {
        const ao = maybeAlsoKeys.has(a.key) ? 0 : 1;
        const bo = maybeAlsoKeys.has(b.key) ? 0 : 1;
        return ao - bo;
      }),
    [addable, maybeAlsoKeys],
  );

  if (ordered.length === 0) return null;

  return (
    <details className="rounded-md border p-3">
      <summary className="text-muted-foreground cursor-pointer text-[11px] font-medium">
        Add more capabilities
      </summary>
      {maybeAlso.length > 0 ? (
        <p className="text-muted-foreground/70 mt-2 text-[11px]">
          Optional — low-confidence suggestions first.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ordered.map((cap) => {
          const suggestion = suggestionByKey.get(cap.key);
          return (
            <button
              key={cap.key}
              type="button"
              onClick={() => onAdd(cap.key)}
              className="hover:bg-muted/50 flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]"
              title={suggestion?.why}
            >
              <Plus className="h-3 w-3" />
              {cap.displayName}
              {suggestion ? (
                <Badge tone="muted" className="text-[11px]">
                  {suggestion.confidence}/10
                </Badge>
              ) : null}
            </button>
          );
        })}
      </div>
    </details>
  );
}

function OptionCard({
  option,
  checked,
  name,
  onSelect,
}: {
  option: RankedOption;
  checked: boolean;
  name: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition-colors",
        checked ? "border-primary/50 bg-primary/5" : "hover:bg-muted/40 border-input",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="sr-only" />
      {/* --primary radio — the one accent, marking the chosen service. */}
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary" : "border-input",
        )}
      >
        {checked ? <span className="bg-primary h-1.5 w-1.5 rounded-full" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1">
          <span className="truncate font-medium">{option.service.displayName}</span>
          {option.isRecommended ? (
            <Badge tone="info" className="shrink-0 px-1 py-0 text-[11px]">
              Recommended
            </Badge>
          ) : null}
        </div>
        {/* Provider as quiet inline mono, not a badge. */}
        <div className="text-muted-foreground mt-0.5 font-mono text-[11px]">
          {providerChip(option.service)}
          {option.crossCloud ? <span className="text-warning"> · cross-cloud</span> : null}
        </div>
        {/* One concise reason line — the top-ranked reason only. */}
        {option.reasons[0] ? (
          <p className="text-muted-foreground mt-1 text-[11px] leading-snug">{option.reasons[0]}</p>
        ) : null}
      </div>
    </label>
  );
}
