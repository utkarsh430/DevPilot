"use client";

// Stack advisor state hook (extracted from StackAdvisorPanel for Phase 2 of
// the plan-component revamp). ALL of the advisor's state, self-load, pure
// ranking derivations, and save/skip/run handlers live here so the same state
// can drive TWO renderings without duplication or a second source of truth:
//
//   • the project page's `<StackAdvisorPanel>` Card (chrome + body), and
//   • the plan surface's pinned Stack Strip + in-sheet overlay, where the
//     strip and the overlay body sit in DIFFERENT DOM positions (pinned above
//     the transcript vs. absolutely positioned over it) and therefore cannot
//     be one self-contained component — they share this hook instead.
//
// This is a pure re-parenting: the data model, the D5 "no auto-fire" contract
// (inference runs ONLY from a `handleRun` click), and the S8 "nothing
// persisted until Save" contract (the only writes are in `handleSave` /
// `handleSkip`) are all unchanged from the original single-component version.

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/sonner";
import { supabaseBrowser } from "@/lib/db/browser";
import {
  runStackAdvisorAction,
  saveStackAdvisorSelectionAction,
  skipStackAdvisorAction,
} from "@/lib/stack/advisor-actions";
import type { StackAdviceStatus } from "@/lib/plan/types";
import type { CapabilitySuggestion } from "@/lib/stack/infer-capabilities";
import { CAPABILITY_CATALOG, getCapability, type CapabilityKey } from "@/lib/stack/capabilities";
import {
  checkCoherence,
  DEFAULT_ECOSYSTEM,
  isEcosystemChoice,
  planStackSelection,
  rankCapability,
  resolveSelectedServiceKey,
  type CapabilityPlan,
  type CoherenceWarning,
  type EcosystemChoice,
  type RankedOption,
} from "@/lib/stack/rank";
import { servicesForCapability } from "@/lib/stack/service-catalog";

export type AdvisorStatus = StackAdviceStatus;

const COLLAPSED_STORAGE_KEY_PREFIX = "devpilot:stack-advisor:collapsed:";

export type UseStackAdvisorArgs = {
  projectId: string;
  /** Set only when mounted inside a plan session's `discussing` phase. */
  sessionId?: string | null;
  /** The session's persisted `planning_sessions.stack_advice_status`, seeded by
   *  the caller. Only used to keep a `skipped` session dismissed across a
   *  reload when the project has no saved tags yet — a real saved selection
   *  (`project_stack_tags`) always wins. */
  initialAdviceStatus?: StackAdviceStatus | null;
};

export type StackAdvisor = ReturnType<typeof useStackAdvisor>;

export function useStackAdvisor({
  projectId,
  sessionId = null,
  initialAdviceStatus = null,
}: UseStackAdvisorArgs) {
  const router = useRouter();

  const [loaded, setLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<AdvisorStatus>("unrun");
  const [ecosystem, setEcosystem] = React.useState<EcosystemChoice>(DEFAULT_ECOSYSTEM);
  const [suggestions, setSuggestions] = React.useState<CapabilitySuggestion[]>([]);
  const [includedCapabilities, setIncludedCapabilities] = React.useState<Set<CapabilityKey>>(
    new Set(),
  );
  const [overrides, setOverrides] = React.useState<Map<CapabilityKey, string>>(new Map());
  const [extraServiceKeys, setExtraServiceKeys] = React.useState<Set<string>>(new Set());
  const [expanded, setExpanded] = React.useState<Set<CapabilityKey>>(new Set());
  const [running, setRunning] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [degraded, setDegraded] = React.useState(false);
  const [degradedReason, setDegradedReason] = React.useState<string | null>(null);

  // ─── Collapse (local UI state, persisted per-project) ────────────────────
  // Read-effect-then-write-effect shape (same as PlanSheet's panel-width
  // persistence): default to expanded for the SSR/first-paint render, then a
  // mount effect reads the stored value so hydration never desyncs. Consumed
  // by the project-page Card; the plan overlay drives its own open state.
  const [collapsed, setCollapsed] = React.useState(false);
  const [collapsedHydrated, setCollapsedHydrated] = React.useState(false);
  React.useEffect(() => {
    const stored = window.localStorage.getItem(`${COLLAPSED_STORAGE_KEY_PREFIX}${projectId}`);
    setCollapsed(stored === "1");
    setCollapsedHydrated(true);
  }, [projectId]);
  React.useEffect(() => {
    if (!collapsedHydrated) return;
    window.localStorage.setItem(
      `${COLLAPSED_STORAGE_KEY_PREFIX}${projectId}`,
      collapsed ? "1" : "0",
    );
  }, [collapsed, collapsedHydrated, projectId]);

  // ─── Self-load: the project's durable, already-saved stack (if any) ──────
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = supabaseBrowser();
      const [projRes, tagsRes] = await Promise.all([
        supabase.from("projects").select("stack_ecosystem").eq("id", projectId).maybeSingle(),
        supabase
          .from("project_stack_tags")
          .select("service_key, capability")
          .eq("project_id", projectId),
      ]);
      if (cancelled) return;
      const eco = projRes.data?.stack_ecosystem;
      if (isEcosystemChoice(eco)) setEcosystem(eco);

      const rows = (tagsRes.data ?? []) as Array<{
        service_key: string;
        capability: string | null;
      }>;
      const extras = new Set<string>();
      const included = new Set<CapabilityKey>();
      const nextOverrides = new Map<CapabilityKey, string>();
      for (const row of rows) {
        if (!row.capability) {
          extras.add(row.service_key);
          continue;
        }
        const capability = getCapability(row.capability);
        if (!capability) continue;
        included.add(capability.key);
        nextOverrides.set(capability.key, row.service_key);
      }
      setExtraServiceKeys(extras);
      if (included.size > 0) {
        setIncludedCapabilities(included);
        setOverrides(nextOverrides);
        setStatus("accepted");
      } else if (initialAdviceStatus === "skipped") {
        // No saved selection, but this session's advisor was dismissed — keep
        // it dismissed across a reload instead of re-offering itself.
        setStatus("skipped");
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, initialAdviceStatus]);

  // ─── Ranking — pure, recomputed on every ecosystem/capability change ────
  const includedOrdered = React.useMemo(
    () => CAPABILITY_CATALOG.filter((e) => includedCapabilities.has(e.key)).map((e) => e.key),
    [includedCapabilities],
  );
  const plans = React.useMemo<CapabilityPlan[]>(
    () => planStackSelection({ capabilities: includedOrdered, ecosystem }),
    [includedOrdered, ecosystem],
  );
  // Validity is decided by the pure `resolveSelectedServiceKey` (rank.ts): a
  // selection is valid if the service can fill the capability AT ALL, not if it
  // happens to be in the ranked top-3 we render. A saved or import-detected pick
  // can legitimately rank 4th and still be the service this project runs.
  const selectedByCapability = React.useMemo(() => {
    const map = new Map<CapabilityKey, string>();
    for (const plan of plans) {
      const key = resolveSelectedServiceKey({
        capability: plan.capability.key,
        preselectedKey: plan.preselectedKey,
        override: overrides.get(plan.capability.key),
      });
      if (key) map.set(plan.capability.key, key);
    }
    return map;
  }, [plans, overrides]);

  // …and because the selection may live outside the top-3, the selected card
  // has to be RENDERED alongside them, or the operator sees three unchecked
  // options and no sign of what is actually saved.
  const pinnedByCapability = React.useMemo(() => {
    const map = new Map<CapabilityKey, RankedOption>();
    for (const plan of plans) {
      const selected = selectedByCapability.get(plan.capability.key);
      if (!selected) continue;
      if (plan.options.some((o) => o.service.key === selected)) continue;
      const full = rankCapability({
        capability: plan.capability.key,
        ecosystem,
        optionsPerCapability: servicesForCapability(plan.capability.key).length,
      });
      const option = full.find((o) => o.service.key === selected);
      if (option) map.set(plan.capability.key, option);
    }
    return map;
  }, [plans, selectedByCapability, ecosystem]);
  const coherenceByCapability = React.useMemo(() => {
    const warnings = checkCoherence({
      ecosystem,
      selections: [...selectedByCapability.entries()].map(([capability, serviceKey]) => ({
        capability,
        serviceKey,
      })),
    });
    const map = new Map<CapabilityKey, CoherenceWarning[]>();
    for (const w of warnings) {
      const list = map.get(w.capability) ?? [];
      list.push(w);
      map.set(w.capability, list);
    }
    return map;
  }, [ecosystem, selectedByCapability]);

  const maybeAlso = suggestions.filter((s) => s.confidence < 5 && !includedCapabilities.has(s.key));
  const suggestionByKey = React.useMemo(
    () => new Map(suggestions.map((s) => [s.key, s])),
    [suggestions],
  );
  const addable = CAPABILITY_CATALOG.filter((e) => !includedCapabilities.has(e.key));

  function toggleExpanded(key: CapabilityKey) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function removeCapability(key: CapabilityKey) {
    setIncludedCapabilities((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function addCapability(key: CapabilityKey) {
    setIncludedCapabilities((prev) => new Set(prev).add(key));
  }

  function selectOption(capability: CapabilityKey, serviceKey: string) {
    setOverrides((prev) => new Map(prev).set(capability, serviceKey));
  }

  async function handleRun() {
    setRunning(true);
    setStatus("inferring");
    const res = await runStackAdvisorAction({ projectId, sessionId });
    setRunning(false);
    if (!res.ok) {
      toast.error("Couldn't run the stack advisor", { description: res.error });
      setStatus(includedCapabilities.size > 0 ? "accepted" : "unrun");
      return;
    }
    setEcosystem(res.ecosystem);
    setSuggestions(res.suggestions);
    setDegraded(res.degraded);
    setDegradedReason(res.degradedReason);
    setIncludedCapabilities(
      new Set(res.suggestions.filter((s) => s.confidence >= 5).map((s) => s.key)),
    );
    setStatus("ready");
  }

  async function handleSave() {
    setSaving(true);
    const selections = [...includedCapabilities].flatMap((capability) => {
      const plan = plans.find((p) => p.capability.key === capability);
      const serviceKey = selectedByCapability.get(capability);
      if (!plan || !serviceKey) return [];
      return [
        {
          capability,
          serviceKey,
          recommendedServiceKey: plan.preselectedKey || serviceKey,
        },
      ];
    });
    const res = await saveStackAdvisorSelectionAction({
      projectId,
      sessionId,
      ecosystem,
      selections,
      extraServiceKeys: [...extraServiceKeys],
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Couldn't save the stack", { description: res.error });
      return false;
    }
    setStatus("accepted");
    toast.success("Stack saved");
    router.refresh();
    return true;
  }

  async function handleSkip() {
    if (!sessionId) return false;
    const res = await skipStackAdvisorAction({ sessionId });
    if (!res.ok) {
      toast.error("Couldn't skip the advisor", { description: res.error });
      return false;
    }
    setStatus("skipped");
    return true;
  }

  // Reopen never re-runs inference (D5) — it only returns to the pre-run
  // "unrun" button state; the operator has to click "Suggest my stack" again.
  function handleReopen() {
    setStatus("unrun");
  }

  return {
    projectId,
    sessionId,
    loaded,
    status,
    ecosystem,
    setEcosystem,
    suggestions,
    includedCapabilities,
    overrides,
    extraServiceKeys,
    setExtraServiceKeys,
    expanded,
    running,
    saving,
    degraded,
    degradedReason,
    collapsed,
    setCollapsed,
    // derived
    plans,
    selectedByCapability,
    pinnedByCapability,
    coherenceByCapability,
    maybeAlso,
    suggestionByKey,
    addable,
    // handlers
    toggleExpanded,
    removeCapability,
    addCapability,
    selectOption,
    handleRun,
    handleSave,
    handleSkip,
    handleReopen,
  };
}
