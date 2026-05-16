"use client";

// Phase 2.5+ / M7 — Plan-tickets surface ("ultra plan" mode).
//
// The PlanSheet is a wide right-side Sheet (sm:max-w-3xl, same trick as
// `TicketDrawer`'s `sm:max-w-xl` override) that wraps the entire plan-mode
// experience. Five visible modes, keyed off `session.status`:
//
//   1. (no session)   — empty state: pick stack flavor + preferences + opener.
//                       Submit creates a `planning_sessions` row and flips to:
//   2. discussing     — chat + composer + "Build plan" CTA. Top strip shows
//                       project + flavor + preferences (debounced patch).
//   3. planning       — progress pills (PM / Tech Lead / DevOps / Consolidator).
//                       Pills flip ✓ when a system-role message with matching
//                       agent_role arrives via Realtime.
//   4. planned        — `<ProposedTicketsReview>` table + commit footer.
//   5. committed/discarded — short success/closed view + "New plan" reset.
//
// Closing the Sheet while planning is in flight is allowed — the panel keeps
// running server-side (Resumable mid-panel cancellation is v2 per the plan).
// We do block close-on-outside-click during the empty-state submit so the
// user can't lose what they typed before the session id comes back.
//
// All server I/O routes through Agent S's actions file
// (`@/app/(app)/plan/actions`). The signatures in that file are the source of
// truth; if they drift, we re-align here.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Diamond,
  ExternalLink,
  FolderGit2,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { supabaseBrowser } from "@/lib/db/browser";
import { useDraft } from "@/lib/drafts/use-draft";
import { useLivePlanMessages } from "@/lib/realtime/use-plan-messages";
import { useLivePlanSession } from "@/lib/realtime/use-plan-session";
import { useStackAdvisor, type StackAdvisor } from "@/components/stack/use-stack-advisor";
import {
  newSessionPrefsSeed,
  shouldSkipPrefsSync,
  type PrefsSyncState,
} from "@/lib/plan/prefs-sync";
import { buildStackProvenance, type StackProvenance } from "@/lib/stack/provenance";
import { PlanStackStrip } from "@/components/plan/PlanStackStrip";
import { PlanStackOverlay } from "@/components/plan/PlanStackOverlay";
import { PlanStageRail } from "@/components/plan/PlanStageRail";
import { TierPicker } from "@/components/team-tiers/TierPicker";
import { resolveEffectiveTier, TEAM_TIER_CONFIG, type TeamTier } from "@/lib/team-tiers/tiers";
import { PlanMessageList } from "@/components/plan/PlanMessageList";
import { ProposedTicketsReview } from "@/components/plan/ProposedTicketsReview";
import { DotsLoader } from "@/components/plan/DotsLoader";
import { RunTerminalPanel } from "@/components/runs/RunTerminalPanel";
import type {
  PlanMessage,
  PlanSession,
  PlanStatus,
  ProposedTicket,
  StackAdviceStatus,
  StackFlavor,
} from "@/lib/plan/types";
// Agent S landed these in apps/web/app/(app)/plan/actions.ts. Note that the
// actions file deliberately does NOT expose a "load snapshot" or
// "patch session prefs" helper — those are RLS-gated direct queries via the
// browser supabase client, which is cheaper than a server round-trip.
import {
  buildPlanUltraAction,
  discardPlanSessionAction,
  restartPlanStepAction,
  sendPlanMessageAction,
  startPlanSessionAction,
} from "@/app/(app)/plan/actions";

// ─── browser-side snapshot loader ─────────────────────────────────────────
// `loadPlanSnapshot` is a thin client-side fetch (RLS-gated) that pulls the
// session row, its messages, and any proposed tickets. We did NOT add an
// action for this because the data is read-only and a server round-trip
// adds no security — RLS already gates by tenant_id.

type RawSessionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  created_by: string | null;
  goal_summary: string | null;
  status: PlanStatus;
  stack_flavor: StackFlavor;
  stack_preferences: string | null;
  spent_cents: number | null;
  billed_at: string | null;
  created_at: string;
  updated_at: string;
  stack_advice_status: StackAdviceStatus | null;
};
type RawMessageRow = {
  id: string;
  session_id: string;
  tenant_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  agent_role: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};
type RawProposedTicketRow = {
  id: string;
  session_id: string;
  tenant_id: string;
  ordinal: number;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  requested_role: string | null;
  depends_on_ordinals: number[] | null;
  selected: boolean;
  committed_ticket_id: string | null;
  created_at: string;
};

function mapSession(r: RawSessionRow): PlanSession {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    projectId: r.project_id,
    createdBy: r.created_by,
    goalSummary: r.goal_summary,
    status: r.status,
    stackFlavor: r.stack_flavor,
    stackPreferences: r.stack_preferences ?? "",
    spentCents: r.spent_cents ?? 0,
    billedAt: r.billed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    stackAdviceStatus: r.stack_advice_status ?? "unrun",
  };
}
function mapMessage(r: RawMessageRow): PlanMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    tenantId: r.tenant_id,
    role: r.role,
    content: r.content,
    agentRole: r.agent_role,
    metadata: r.metadata,
    createdAt: r.created_at,
  };
}
function mapProposedTicket(r: RawProposedTicketRow): ProposedTicket {
  return {
    id: r.id,
    sessionId: r.session_id,
    tenantId: r.tenant_id,
    ordinal: r.ordinal,
    title: r.title,
    description: r.description,
    acceptanceCriteria: r.acceptance_criteria,
    requestedRole: r.requested_role,
    dependsOnOrdinals: r.depends_on_ordinals ?? [],
    selected: r.selected,
    committedTicketId: r.committed_ticket_id,
    createdAt: r.created_at,
  };
}

async function loadPlanSnapshot(sessionId: string): Promise<
  | {
      ok: true;
      session: PlanSession;
      messages: PlanMessage[];
      proposedTickets: ProposedTicket[];
    }
  | { ok: false; error: string }
> {
  const supabase = supabaseBrowser();
  const [sessRes, msgRes, propRes] = await Promise.all([
    supabase
      .from("planning_sessions")
      .select(
        "id, tenant_id, project_id, created_by, goal_summary, status, stack_flavor, stack_preferences, spent_cents, billed_at, created_at, updated_at, stack_advice_status",
      )
      .eq("id", sessionId)
      .maybeSingle(),
    supabase
      .from("planning_messages")
      .select("id, session_id, tenant_id, role, content, agent_role, metadata, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true }),
    supabase
      .from("planning_proposed_tickets")
      .select(
        "id, session_id, tenant_id, ordinal, title, description, acceptance_criteria, requested_role, depends_on_ordinals, selected, committed_ticket_id, created_at",
      )
      .eq("session_id", sessionId)
      .order("ordinal", { ascending: true }),
  ]);
  if (sessRes.error || !sessRes.data) {
    return { ok: false, error: sessRes.error?.message ?? "session not found" };
  }
  return {
    ok: true,
    session: mapSession(sessRes.data as RawSessionRow),
    messages: ((msgRes.data ?? []) as RawMessageRow[]).map(mapMessage),
    proposedTickets: ((propRes.data ?? []) as RawProposedTicketRow[]).map(mapProposedTicket),
  };
}

/**
 * Direct RLS-gated patch of `planning_sessions.stack_flavor` / `.stack_preferences`.
 * We don't need a server action here — RLS already enforces tenant-scope
 * and there's no LLM call to cost-gate.
 */
async function patchSessionPrefs(
  sessionId: string,
  patch: { stackFlavor?: StackFlavor; stackPreferences?: string },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = supabaseBrowser();
  const dbPatch: Record<string, unknown> = {};
  if (patch.stackFlavor !== undefined) dbPatch.stack_flavor = patch.stackFlavor;
  if (patch.stackPreferences !== undefined) dbPatch.stack_preferences = patch.stackPreferences;
  if (Object.keys(dbPatch).length === 0) return { ok: true };
  const { error } = await supabase.from("planning_sessions").update(dbPatch).eq("id", sessionId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const PANEL_STAGES: ReadonlyArray<{
  key: "pm" | "tech_lead" | "devops" | "consolidator";
  label: string;
}> = [
  { key: "pm", label: "PM" },
  { key: "tech_lead", label: "Tech Lead" },
  { key: "devops", label: "DevOps" },
  { key: "consolidator", label: "Consolidator" },
];

const PREFS_PATCH_DEBOUNCE_MS = 800;

// ─── Left-edge drag-to-resize (operator-adjustable panel width) ───────────
const PANEL_WIDTH_STORAGE_KEY = "devpilot:plan-sheet-width";
const PANEL_DEFAULT_WIDTH_PX = 768; // 48rem - matches the old fixed sm:max-w-3xl cap.
const PANEL_MIN_WIDTH_PX = 480;
const PANEL_MAX_WIDTH_PX = 1120;
const PANEL_RESIZE_KEYBOARD_STEP_PX = 24;

function clampPanelWidth(width: number): number {
  const viewportCap = typeof window !== "undefined" ? window.innerWidth * 0.9 : PANEL_MAX_WIDTH_PX;
  const max = Math.max(Math.min(PANEL_MAX_WIDTH_PX, viewportCap), PANEL_MIN_WIDTH_PX);
  return Math.min(Math.max(width, PANEL_MIN_WIDTH_PX), max);
}

export type PlanSheetProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Required to start a fresh session. */
  activeProjectId: string;
  projectName: string;
  /**
   * Project's default team tier — shown as the "Inherit" option in the
   * empty-state tier picker. Optional for resume-only consumers
   * (`<PlanSheetButton>`, /plan history list) that never render the
   * empty-state form; defaults to 'standard' there.
   */
  projectTier?: TeamTier;
  /**
   * If supplied, the Sheet opens directly to that session (Resume from
   * `<PlanningCard>`). Otherwise it opens to the empty/initial state.
   */
  initialSessionId?: string | null;
};

export function PlanSheet({
  open,
  onOpenChange,
  activeProjectId,
  projectName,
  projectTier = "standard",
  initialSessionId,
}: PlanSheetProps) {
  const router = useRouter();

  // ─── Session ── null until we either resume or call startPlanSessionAction.
  const [session, setSession] = React.useState<PlanSession | null>(null);
  const [seedMessages, setSeedMessages] = React.useState<PlanMessage[]>([]);
  const [proposedTickets, setProposedTickets] = React.useState<ProposedTicket[]>([]);
  const [snapshotLoading, setSnapshotLoading] = React.useState(false);

  // ─── Empty-state form ───────────────────────────────────────────────────
  const [flavor, setFlavor] = React.useState<StackFlavor>("mixed");
  // null = inherit project default; only consulted on the new-session path.
  const [tierOverride, setTierOverride] = React.useState<TeamTier | null>(null);
  // Drafts: pre-session form survives refresh AND accidental Sheet-close.
  // Keys go null once a session exists so the canonical store (the DB row +
  // debounced patch below) takes over and we don't fight it.
  const isFreshSession = !initialSessionId && !session;
  const openerKey = isFreshSession ? `plan-draft:new:${activeProjectId}:opener` : null;
  const prefsKey = isFreshSession ? `plan-draft:new:${activeProjectId}:prefs` : null;
  // Third tuple slot (`clear`) is intentionally unused: we no longer blank the
  // live `prefs` draft on start — see `onStart` for why (it would clobber the
  // just-persisted stack_preferences). Stale localStorage is cleared directly.
  const [prefs, setPrefs] = useDraft(prefsKey, "");
  const [opener, setOpener, clearOpenerDraft] = useDraft(openerKey, "");
  const [starting, setStarting] = React.useState(false);

  // ─── Discussion composer ────────────────────────────────────────────────
  const replyKey = session ? `plan-draft:session:${session.id}:composer` : null;
  const [reply, setReply, clearReplyDraft] = useDraft(replyKey, "");
  const [sending, setSending] = React.useState(false);
  const [building, setBuilding] = React.useState(false);
  const [buildStartedAt, setBuildStartedAt] = React.useState<number | null>(null);

  // ─── Live messages ──────────────────────────────────────────────────────
  const { messages, isLive } = useLivePlanMessages(session?.id ?? null, seedMessages);

  // ─── Live session row ──────────────────────────────────────────────────
  // Mirrors `messages` above: the snapshot helper seeds `session` from
  // `loadPlanSnapshot`; this hook then overlays any UPDATE/DELETE on the row
  // (Inngest status transitions, Agent S's auto-rollback, a second tab
  // discarding it) so the Sheet's mode flips without a refresh.
  const { session: liveSession, isLive: liveSessionIsLive } = useLivePlanSession(
    session?.id ?? null,
    session,
  );

  // Close the Sheet only when the live subscription is ALIVE and reports
  // null — that means a DELETE actually came in from realtime. The
  // earlier-version race (`session && liveSession === null`) tripped
  // immediately after `setSession(res.session)` because the hook's
  // internal state hadn't caught up to the new seed yet; on that first
  // render `liveSession` is still null, the effect read `session` truthy
  // + `liveSession === null` → true, and closed the freshly-opened sheet.
  // Gating on `liveSessionIsLive` proves the realtime channel actually
  // saw the row disappear.
  React.useEffect(() => {
    if (session && liveSession === null && liveSessionIsLive) {
      onOpenChange(false);
    }
  }, [session, liveSession, liveSessionIsLive, onOpenChange]);

  // `effectiveSession` is what the rest of the UI reads. Prefer the live
  // value so status transitions land instantly, but fall back to the local
  // copy during the brief window before the first realtime UPDATE lands
  // (and so optimistic local updates remain visible).
  const effectiveSession = liveSession ?? session;

  // ─── Stack advisor (hoisted, Phase 4) ────────────────────────────────────
  // The advisor is instantiated ONCE at the sheet level so its self-loaded
  // saved stack is consumed across every phase — the Refine strip/overlay, the
  // Build "Building on your stack" line, AND the Review "Planned on:" banner.
  // (In Phase 2 it lived inside `DiscussionOrPlanning`, which unmounts on the
  // transition to `planned`, leaving the Review moment with no stack to show.)
  // This is a re-parent of the EXISTING hook, not a new fetch: it performs the
  // same single RLS-gated self-load, just early enough to be available at
  // Review. `projectId` prefers the session's own project so a cross-project
  // resume reads the right tags; it falls back to `activeProjectId` before a
  // session exists. D5 / S8 contracts are untouched (they live in the hook).
  const advisor = useStackAdvisor({
    projectId: effectiveSession?.projectId ?? activeProjectId,
    sessionId: effectiveSession?.id ?? null,
    initialAdviceStatus: effectiveSession?.stackAdviceStatus ?? null,
  });
  const stackProvenance = React.useMemo(
    () =>
      buildStackProvenance({
        loaded: advisor.loaded,
        status: advisor.status,
        ecosystem: advisor.ecosystem,
        plans: advisor.plans,
        selectedByCapability: advisor.selectedByCapability,
        extraServiceKeys: advisor.extraServiceKeys,
      }),
    [
      advisor.loaded,
      advisor.status,
      advisor.ecosystem,
      advisor.plans,
      advisor.selectedByCapability,
      advisor.extraServiceKeys,
    ],
  );

  // ─── Resume path: load snapshot when initialSessionId changes ──────────
  React.useEffect(() => {
    if (!open || !initialSessionId) return;
    let cancelled = false;
    setSnapshotLoading(true);
    void (async () => {
      const res = await loadPlanSnapshot(initialSessionId);
      if (cancelled) return;
      setSnapshotLoading(false);
      if (!res.ok) {
        toast.error("Couldn't load planning session", { description: res.error });
        return;
      }
      setSession(res.session);
      setSeedMessages(res.messages);
      setProposedTickets(res.proposedTickets);
      setFlavor(res.session.stackFlavor);
      setPrefs(res.session.stackPreferences);
    })();
    return () => {
      cancelled = true;
    };
    // setPrefs comes from useDraft; its identity is stable across renders
    // (it's the useState setter under the hood) but the lint rule can't see
    // through the custom hook. Including it would force the effect to
    // re-run whenever `prefsKey` flips (session toggle), which would race
    // an in-flight snapshot load. Deliberately scoped to the resume trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSessionId]);

  // ─── Reset state when the Sheet closes (fresh start next open) ─────────
  React.useEffect(() => {
    if (open) return;
    setSession(null);
    setSeedMessages([]);
    setProposedTickets([]);
    setBuilding(false);
    setBuildStartedAt(null);
    // Intentionally NOT clearing `opener` / `prefs` / `reply` — those are
    // managed by `useDraft` and survive close so an accidental dismiss
    // doesn't drop a half-typed message. They clear on successful submit.
  }, [open]);

  // ─── Folder Realtime messages back into local proposedTickets state ────
  // The planning_proposed_tickets table isn't on the publication for v1, so
  // we reload the snapshot when we detect a status transition to 'planned'
  // arriving via the messages stream. The Consolidator's last system message
  // serves as the "they're ready" signal.
  const sessionId = session?.id ?? null;
  React.useEffect(() => {
    if (!sessionId) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    // Heuristic: a Consolidator-stage system message with content containing
    // "finished" / "complete" / "ready" indicates we should refetch. Server
    // can normalize the wording later; the refetch is idempotent.
    if (
      last.role === "system" &&
      last.agentRole === "consolidator" &&
      /finish|complete|ready|done/i.test(last.content)
    ) {
      void (async () => {
        const res = await loadPlanSnapshot(sessionId);
        if (!res.ok) return;
        setSession(res.session);
        setProposedTickets(res.proposedTickets);
        setBuilding(false);
        setBuildStartedAt(null);
      })();
    }
  }, [messages, sessionId]);

  // Same idea, but driven off the live session status: when the realtime
  // hook flips to `planned` (orchestrator wrote it directly to the row), we
  // need the proposed-ticket rows on the client too. The status check
  // dedupes against the message-driven refetch above.
  React.useEffect(() => {
    if (!sessionId) return;
    if (liveSession?.status !== "planned") return;
    if (session?.status === "planned" && proposedTickets.length > 0) return;
    void (async () => {
      const res = await loadPlanSnapshot(sessionId);
      if (!res.ok) return;
      setSession(res.session);
      setProposedTickets(res.proposedTickets);
      setBuilding(false);
      setBuildStartedAt(null);
    })();
  }, [liveSession?.status, sessionId, session?.status, proposedTickets.length]);

  // ─── Derived progress pill state ────────────────────────────────────────
  // A system-role message with `agentRole` flips the matching pill to ✓.
  const completedStages = React.useMemo(() => {
    const done = new Set<string>();
    for (const m of messages) {
      if (m.role !== "system") continue;
      if (!m.agentRole) continue;
      if (/finish|complete|ready|done/i.test(m.content)) done.add(m.agentRole);
    }
    return done;
  }, [messages]);

  // ─── Debounced preferences patch ────────────────────────────────────────
  const prefsTimer = React.useRef<NodeJS.Timeout | null>(null);
  const lastSentPrefs = React.useRef<PrefsSyncState | null>(null);
  React.useEffect(() => {
    // Only patch when there IS a session — empty-state edits seed the form,
    // they don't write to the DB.
    if (!session) return;
    // Skip the initial sync that fires when we load the session (the snapshot
    // already matches the server state). The resume path sets `prefs` to the
    // DB value, so even the unseeded first sync is a harmless identical
    // re-write; the new-session path additionally seeds `lastSentPrefs.current`
    // in `onStart` so this genuinely skips instead of clobbering the just-saved
    // prefs with an emptied draft.
    if (shouldSkipPrefsSync(lastSentPrefs.current, { flavor, prefs })) return;
    if (prefsTimer.current) clearTimeout(prefsTimer.current);
    prefsTimer.current = setTimeout(async () => {
      lastSentPrefs.current = { flavor, prefs };
      const res = await patchSessionPrefs(session.id, {
        stackFlavor: flavor,
        stackPreferences: prefs,
      });
      if (!res.ok) {
        toast.error("Couldn't save preferences", { description: res.error });
      }
    }, PREFS_PATCH_DEBOUNCE_MS);
    return () => {
      if (prefsTimer.current) clearTimeout(prefsTimer.current);
    };
  }, [session, flavor, prefs]);

  // ─── Handlers ───────────────────────────────────────────────────────────
  async function onStart(e: React.FormEvent) {
    e.preventDefault();
    if (opener.trim().length === 0) return;
    setStarting(true);
    const res = await startPlanSessionAction({
      projectId: activeProjectId,
      stackFlavor: flavor,
      stackPreferences: prefs,
      openingMessage: opener.trim(),
      teamTier: tierOverride,
    });
    setStarting(false);
    if (!res.ok) {
      toast.error("Couldn't start planning", { description: res.error });
      return;
    }
    // Optimistically transition: the server returns just sessionId; we trust
    // it and reload via the snapshot helper so the chat seed and prefs match.
    const snap = await loadPlanSnapshot(res.sessionId);
    if (!snap.ok) {
      toast.error("Couldn't load new session", { description: snap.error });
      return;
    }
    setSession(snap.session);
    setSeedMessages(snap.messages);
    setProposedTickets(snap.proposedTickets);
    // The typed prefs are now persisted on the session row. Seed the debounced
    // prefs-sync guard to that persisted value AND mirror it into local `prefs`
    // so the first sync is a genuine no-op (mirrors the resume path, which sets
    // `prefs` to the DB value). We must NOT `clearPrefsDraft()` here: it empties
    // the live `prefs` state, and the unseeded debounced effect then wrote that
    // "" back over the just-saved `stack_preferences` ~800ms later (the bug).
    lastSentPrefs.current = newSessionPrefsSeed(flavor, snap.session.stackPreferences);
    setPrefs(snap.session.stackPreferences);
    clearOpenerDraft();
    // `prefsKey` flips to null once `session` is set, so useDraft's write effect
    // early-returns and won't clear the stale localStorage draft under the old
    // (fresh-session) key. Remove it explicitly — `prefsKey` still resolves to
    // that key in this closure (session was null when this handler was created).
    if (prefsKey) {
      try {
        window.localStorage.removeItem(prefsKey);
      } catch {
        // storage may be disabled (privacy mode); ignore.
      }
    }
  }

  async function onSend() {
    if (!session || reply.trim().length === 0) return;
    setSending(true);
    const body = reply.trim();
    // Optimistic: don't clear input yet — keep until server accepts.
    const res = await sendPlanMessageAction({
      sessionId: session.id,
      content: body,
    });
    setSending(false);
    if (!res.ok) {
      toast.error("Couldn't send", { description: res.error });
      return;
    }
    clearReplyDraft();
    // The user + assistant turns arrive via Realtime; no manual append.
  }

  async function onBuild() {
    if (!session) return;
    setBuilding(true);
    setBuildStartedAt(Date.now());
    const res = await buildPlanUltraAction({ sessionId: session.id });
    if (!res.ok) {
      setBuilding(false);
      setBuildStartedAt(null);
      toast.error("Couldn't build plan", { description: res.error });
      return;
    }
    // Optimistic UI: transition to `planning` immediately. The snapshot
    // refresh in the Realtime effect will flip to `planned` once the
    // Consolidator finishes.
    setSession((cur) => (cur ? { ...cur, status: "planning" } : cur));
  }

  function onCommitted(_committedTicketIds: string[]) {
    // Pull the session row to reflect status=committed; then refresh the
    // board so the new tickets show up.
    if (!session) return;
    setSession((cur) => (cur ? { ...cur, status: "committed" } : cur));
    router.refresh();
  }
  function onDiscarded() {
    if (!session) return;
    setSession((cur) => (cur ? { ...cur, status: "discarded" } : cur));
  }

  // Cancel an in-flight build. `discardPlanSessionAction` is the only
  // session-state-mutating action exposed today and it sets status to the
  // terminal `discarded` end-state — so the button reads "Discard build" to
  // match the destructive semantic. The session row's realtime UPDATE then
  // drives the Sheet to the discarded mode without a refresh.
  const [cancelling, setCancelling] = React.useState(false);
  async function onCancelBuild() {
    if (!session) return;
    if (cancelling) return;
    const ok = window.confirm(
      "Discard this build? The transcript will be archived; you can start a fresh plan any time.",
    );
    if (!ok) return;
    setCancelling(true);
    const res = await discardPlanSessionAction({ sessionId: session.id });
    setCancelling(false);
    if (!res.ok) {
      toast.error("Couldn't discard build", { description: res.error });
      return;
    }
    toast.success("Build discarded");
    // Optimistic local flip; the realtime hook will confirm. Also clears
    // the in-flight build flags so the progress strip stops ticking even
    // before the row update lands.
    setBuilding(false);
    setBuildStartedAt(null);
    setSession((cur) => (cur ? { ...cur, status: "discarded" } : cur));
  }

  // Restart a single failed plan-mode step (one panel OR the consolidator).
  // Distinct from "Cancel build" which kills the entire transcript and
  // proposed-tickets. The restart action re-emits ONLY the matching Inngest
  // event with a fresh runId so the failed pill picks up where it timed out
  // (or errored) without redoing the panels-that-already-finished.
  //
  // Per-stage in-flight flag so two consecutive clicks on different pills
  // don't race; the restart-by-stage map is keyed by the same `stage` token
  // the server action accepts.
  const [restartingStage, setRestartingStage] = React.useState<string | null>(null);
  async function onRestartStage(
    stage: "panel:pm" | "panel:tech_lead" | "panel:devops" | "consolidator",
  ) {
    if (!session) return;
    if (restartingStage !== null) return;
    setRestartingStage(stage);
    const res = await restartPlanStepAction({
      sessionId: session.id,
      stage,
    });
    setRestartingStage(null);
    if (!res.ok) {
      toast.error("Couldn't restart step", { description: res.error });
      return;
    }
    toast.success(
      stage === "consolidator"
        ? "Consolidator restarting…"
        : `${stage.replace("panel:", "")} panel restarting…`,
    );
    // Re-arm the build flags so the strip's elapsed counter resets and the
    // UI sticks in the planning view while the restart runs. The realtime
    // hook will overlay the new pill states from the incoming system
    // messages (panel.start / consolidator.start) as the runner picks them
    // up.
    setBuilding(true);
    setBuildStartedAt(Date.now());
    setSession((cur) => (cur ? { ...cur, status: "planning" } : cur));
  }

  // ─── Close-guard ────────────────────────────────────────────────────────
  // Block close-on-outside-click ONLY during the empty-state submit so we
  // don't drop the operator's opener. Planning-in-flight is allowed to close;
  // the server keeps running.
  function onSheetOpenChange(o: boolean) {
    if (!o && starting) return;
    onOpenChange(o);
  }

  // ─── Left-edge drag-to-resize ───────────────────────────────────────────
  // `panelWidth` starts at the old fixed cap so the first paint (server +
  // pre-hydration client render) matches exactly, then a mount effect reads
  // the persisted width - reading localStorage during the state initializer
  // would desync the SSR'd markup from the client's first render.
  const [panelWidth, setPanelWidth] = React.useState(PANEL_DEFAULT_WIDTH_PX);
  const [widthHydrated, setWidthHydrated] = React.useState(false);
  const [resizing, setResizing] = React.useState(false);
  const dragStartRef = React.useRef<{ startX: number; startWidth: number } | null>(null);

  React.useEffect(() => {
    const stored = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    setPanelWidth(clampPanelWidth(Number.isFinite(parsed) ? parsed : PANEL_DEFAULT_WIDTH_PX));
    setWidthHydrated(true);
  }, []);

  // Persist once hydrated - gated on `widthHydrated` so this doesn't fire
  // with the pre-hydration default and clobber a previously saved width
  // before the read-effect above has a chance to run.
  React.useEffect(() => {
    if (!widthHydrated) return;
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(panelWidth));
  }, [panelWidth, widthHydrated]);

  // Re-clamp on viewport shrink (e.g. a persisted wide width on a narrower
  // window) so the panel can never grow past 90vw.
  React.useEffect(() => {
    function handleWindowResize() {
      setPanelWidth((w) => clampPanelWidth(w));
    }
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  React.useEffect(() => {
    if (!resizing) return;
    function handlePointerMove(e: PointerEvent) {
      const drag = dragStartRef.current;
      if (!drag) return;
      // Handle sits on the LEFT edge: dragging left (clientX decreases)
      // widens the panel; dragging right narrows it.
      const delta = drag.startX - e.clientX;
      setPanelWidth(clampPanelWidth(drag.startWidth + delta));
    }
    function stopResizing() {
      dragStartRef.current = null;
      setResizing(false);
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    window.addEventListener("blur", stopResizing);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      window.removeEventListener("blur", stopResizing);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [resizing]);

  function onResizeHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Left-click / primary touch only.
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    dragStartRef.current = { startX: e.clientX, startWidth: panelWidth };
    setResizing(true);
  }

  function onResizeHandleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPanelWidth((w) => clampPanelWidth(w + PANEL_RESIZE_KEYBOARD_STEP_PX));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setPanelWidth((w) => clampPanelWidth(w - PANEL_RESIZE_KEYBOARD_STEP_PX));
    }
  }

  return (
    <Sheet open={open} onOpenChange={onSheetOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
        style={widthHydrated ? { width: panelWidth, maxWidth: panelWidth } : undefined}
        // Prevent overlay-click close during a starting submit.
        onInteractOutside={(e) => {
          if (starting) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (starting) e.preventDefault();
        }}
      >
        {/* Left-edge drag handle - grabs the panel's left border to resize
            the whole planning component. Hit-region is wider than the
            visible line for an easier grab; centered on the panel's
            existing `border-l`. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize planning panel"
          aria-valuenow={Math.round(panelWidth)}
          aria-valuemin={PANEL_MIN_WIDTH_PX}
          aria-valuemax={PANEL_MAX_WIDTH_PX}
          tabIndex={0}
          onPointerDown={onResizeHandlePointerDown}
          onKeyDown={onResizeHandleKeyDown}
          className="absolute left-0 top-0 z-10 hidden h-full w-2.5 -translate-x-1/2 cursor-ew-resize touch-none select-none items-center justify-center sm:flex"
        >
          <div
            className={cn(
              "h-full w-px transition-colors",
              resizing ? "bg-primary w-0.5" : "bg-border hover:bg-primary/60",
            )}
          />
        </div>
        {/* Header — universal across modes */}
        <div className="flex flex-col gap-1.5 border-b px-6 py-4 pr-12">
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <FolderGit2 className="h-3 w-3" />
            <span className="text-foreground truncate font-medium">{projectName}</span>
            {effectiveSession?.goalSummary ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{effectiveSession.goalSummary}</span>
              </>
            ) : null}
            <span className="ml-auto inline-flex items-center gap-2">
              {effectiveSession ? (
                <Badge tone="muted" className="font-mono text-[11px]">
                  spent ${(effectiveSession.spentCents / 100).toFixed(2)}
                </Badge>
              ) : null}
              <LiveDot isLive={isLive} />
            </span>
          </div>
          <SheetTitle className="font-display flex items-center gap-2 pr-2 text-lg leading-snug">
            <Sparkles className="text-muted-foreground h-4 w-4" />
            Plan tickets
          </SheetTitle>
          <SheetDescription className="sr-only">
            Multi-turn planning surface — the panel agents draft a curated ticket list you can
            review and bulk-commit to the board.
          </SheetDescription>
        </div>

        {/* Stage rail — the pinned lifecycle spine (Phase 5). A pure,
            non-gating derivation of `effectiveSession?.status`: it reflects
            where the operator is (Describe · Refine · Build · Review) and
            collapses to a terminal chip on committed/discarded. It never gates
            the composer/advisor or drives status. */}
        <PlanStageRail status={effectiveSession?.status ?? null} />

        {/* Body — mode-dispatched */}
        {snapshotLoading ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            Loading session…
          </div>
        ) : effectiveSession === null ? (
          <EmptyState
            prefs={prefs}
            onPrefsChange={setPrefs}
            opener={opener}
            onOpenerChange={setOpener}
            starting={starting}
            onSubmit={onStart}
            projectTier={projectTier}
            tierOverride={tierOverride}
            onTierOverrideChange={setTierOverride}
          />
        ) : effectiveSession.status === "discussing" || effectiveSession.status === "planning" ? (
          <DiscussionOrPlanning
            session={effectiveSession}
            advisor={advisor}
            stackProvenance={stackProvenance}
            teamTier={resolveEffectiveTier(projectTier, tierOverride)}
            prefs={prefs}
            onPrefsChange={setPrefs}
            messages={messages}
            reply={reply}
            onReplyChange={setReply}
            sending={sending}
            onSend={onSend}
            building={building || effectiveSession.status === "planning"}
            buildStartedAt={buildStartedAt}
            onBuild={onBuild}
            onCancelBuild={onCancelBuild}
            cancelling={cancelling}
            completedStages={completedStages}
            onRestartStage={onRestartStage}
            restartingStage={restartingStage}
          />
        ) : effectiveSession.status === "planned" ? (
          <ProposedTicketsReview
            sessionId={effectiveSession.id}
            tickets={proposedTickets}
            stackProvenance={stackProvenance}
            onCommitted={onCommitted}
            onDiscarded={onDiscarded}
          />
        ) : effectiveSession.status === "committed" ? (
          <ClosedState
            tone="ok"
            title="Plan committed"
            description="The selected tickets are now in Backlog. Drag one to Ready to start the agent loop."
            actionLabel="View on board"
            actionHref="/board"
            secondaryLabel="New plan"
            onSecondary={() => {
              setSession(null);
              setSeedMessages([]);
              setProposedTickets([]);
            }}
          />
        ) : (
          <ClosedState
            tone="muted"
            title="Session discarded"
            description="This planning session is closed. Start a new one to begin again."
            actionLabel="New plan"
            onAction={() => {
              setSession(null);
              setSeedMessages([]);
              setProposedTickets([]);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function LiveDot({ isLive }: { isLive: boolean }) {
  return (
    <span className="relative inline-flex h-1.5 w-1.5">
      {isLive ? (
        <span className="bg-success absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
      ) : null}
      <span
        className={cn(
          "relative inline-flex h-1.5 w-1.5 rounded-full",
          isLive ? "bg-success" : "bg-warning",
        )}
      />
    </span>
  );
}

// A few starter descriptions the operator can drop straight into the opener
// — pure convenience, no state beyond filling the textarea (Phase 1 "hero
// opener" nicety from the plan-revamp spec).
const EXAMPLE_OPENERS: ReadonlyArray<string> = [
  "Add Stripe metered billing — per-token spend becomes a monthly invoice",
  "Build a CSV import + export flow for the main list view",
  "Add email notifications when someone comments on my item",
];

function EmptyState({
  prefs,
  onPrefsChange,
  opener,
  onOpenerChange,
  starting,
  onSubmit,
  projectTier,
  tierOverride,
  onTierOverrideChange,
}: {
  prefs: string;
  onPrefsChange: (s: string) => void;
  opener: string;
  onOpenerChange: (s: string) => void;
  starting: boolean;
  onSubmit: (e: React.FormEvent) => void;
  projectTier: TeamTier;
  tierOverride: TeamTier | null;
  onTierOverrideChange: (t: TeamTier | null) => void;
}) {
  const canSubmit = !starting && opener.trim().length > 0;
  // Collapsed by default — auto-expands the first time the operator already
  // has prefs typed (drafts survive a re-open) so nothing hides behind a
  // chevron unannounced.
  const [prefsOpen, setPrefsOpen] = React.useState(prefs.trim().length > 0);

  return (
    <form
      onSubmit={onSubmit}
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5"
    >
      {/* Hero opener — first and largest control on the page. */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="plan-opener"
          className="font-display flex items-center gap-2 text-sm font-semibold"
        >
          <Sparkles className="text-muted-foreground h-3.5 w-3.5" />
          What are you building?
        </label>
        <Textarea
          id="plan-opener"
          autoFocus
          rows={8}
          placeholder="e.g. add Stripe metered billing — per-token spend on the runs page becomes a monthly invoice."
          value={opener}
          onChange={(e) => onOpenerChange(e.target.value)}
          className="text-sm"
        />
        <p className="text-muted-foreground text-[11px]">
          One paragraph is enough — the planner lead will clarify scope before the panel
          deliberates.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLE_OPENERS.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onOpenerChange(example)}
              className="text-muted-foreground hover:border-primary/40 hover:text-foreground border-input rounded-full border px-2.5 py-1 text-[11px] transition-colors"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      <TierPicker
        value={tierOverride}
        onChange={onTierOverrideChange}
        allowInherit
        inheritedLabel={`Inherit (${TEAM_TIER_CONFIG[projectTier].displayName})`}
        disabled={starting}
      />

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => setPrefsOpen((o) => !o)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-[11px] transition-colors"
          aria-expanded={prefsOpen}
        >
          {prefsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          Add preferences <span className="font-normal">(optional)</span>
        </button>
        {prefsOpen ? (
          <Textarea
            id="plan-prefs"
            rows={2}
            placeholder='e.g. "Postgres OK, no AWS, prefer Vercel"'
            value={prefs}
            onChange={(e) => onPrefsChange(e.target.value)}
          />
        ) : null}
      </div>

      <div className="mt-auto flex justify-end">
        <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
          {starting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {starting ? "Starting…" : "Start planning"}
        </Button>
      </div>
    </form>
  );
}

function DiscussionOrPlanning({
  session,
  advisor,
  stackProvenance,
  teamTier,
  prefs,
  onPrefsChange,
  messages,
  reply,
  onReplyChange,
  sending,
  onSend,
  building,
  buildStartedAt,
  onBuild,
  onCancelBuild,
  cancelling,
  completedStages,
  onRestartStage,
  restartingStage,
}: {
  session: PlanSession;
  /** The sheet-level advisor instance (hoisted in Phase 4) driving the pinned
   *  Stack Strip + overlay. */
  advisor: StackAdvisor;
  /** Derived provenance for the Build "Building on your stack" line. */
  stackProvenance: StackProvenance;
  /** Effective team tier — seeds the advisor density dial's default view. */
  teamTier: TeamTier;
  prefs: string;
  onPrefsChange: (s: string) => void;
  messages: PlanMessage[];
  reply: string;
  onReplyChange: (s: string) => void;
  sending: boolean;
  onSend: () => void;
  building: boolean;
  buildStartedAt: number | null;
  onBuild: () => void;
  onCancelBuild: () => void;
  cancelling: boolean;
  completedStages: Set<string>;
  onRestartStage: (stage: "panel:pm" | "panel:tech_lead" | "panel:devops" | "consolidator") => void;
  restartingStage: string | null;
}) {
  const isPlanning = session.status === "planning" || building;
  const userMessageCount = messages.filter((m) => m.role === "user").length;

  // The stack advisor is now hoisted to the sheet level (Phase 4) and passed in
  // as a prop so the SAME self-loaded saved stack drives the pinned strip +
  // overlay HERE and the Build/Review provenance surfaces elsewhere. D5 (no
  // auto-fire) / S8 (save-only writes) still live in the hook.

  // The overlay is a transient focused layer; it defaults CLOSED on mount so it
  // never auto-covers the chat on load. (Deliberately NOT seeded from the
  // advisor's persisted collapse boolean — an overlay that opens itself over
  // the transcript every reload would be a regression, not the strip's home.)
  const [overlayOpen, setOverlayOpen] = React.useState(false);

  // "First answered Q&A round" signal: a `role: "user"` message whose
  // `metadata.answers` is a non-empty array (QuestionPanel's `PendingAnswer[]`,
  // exactly what `submitPlanAnswersAction` writes / `loadAdvisorAnswers` reads).
  // The advisor is meaningfully sharper after this round. It no longer GATES
  // visibility (the strip is always present) — it only promotes the `unrun`
  // strip CTA from quiet → primary (the "auto-offer"). D5 is preserved:
  // inference still only ever runs from a click.
  const hasAnsweredFirstRound = React.useMemo(
    () =>
      messages.some((m) => {
        if (m.role !== "user") return false;
        const answers = (m.metadata as { answers?: unknown[] } | null)?.answers;
        return Array.isArray(answers) && answers.length > 0;
      }),
    [messages],
  );

  // When inference the operator kicked off lands (status → `ready`), open the
  // overlay so they can review the suggestions they asked for. One-shot per
  // transition (tracked against the previous status) so closing it stays
  // closed; never fires for a reload that self-loads straight into `accepted`.
  const prevStatusRef = React.useRef(advisor.status);
  React.useEffect(() => {
    if (advisor.status === "ready" && prevStatusRef.current !== "ready") {
      setOverlayOpen(true);
    }
    prevStatusRef.current = advisor.status;
  }, [advisor.status]);

  // Brief Loader2 spin on Build click so the operator gets immediate
  // feedback in the ~1.5s window before the real progress strip takes over.
  const [buildClicking, setBuildClicking] = React.useState(false);
  React.useEffect(() => {
    // Once `isPlanning` flips true (server transitions to `planning` and the
    // PlanningProgressStrip mounts), drop the local spinner.
    if (isPlanning) setBuildClicking(false);
  }, [isPlanning]);
  React.useEffect(() => {
    if (!buildClicking) return;
    // Hard safety: never leave the local spinner stuck longer than 2s if the
    // server transition is sluggish — the progress strip will take it from
    // there.
    const id = setTimeout(() => setBuildClicking(false), 2_000);
    return () => clearTimeout(id);
  }, [buildClicking]);

  function handleBuildClick() {
    setBuildClicking(true);
    onBuild();
  }

  // Pending "lead is thinking…" state. Derived from messages tail so it
  // survives a mid-conversation refresh — no DB flag needed.
  const lastMessage = messages[messages.length - 1] ?? null;
  const showPendingLead =
    !isPlanning && lastMessage?.role === "user" && session.status === "discussing";
  const [pendingStale, setPendingStale] = React.useState(false);
  React.useEffect(() => {
    if (!showPendingLead || !lastMessage) {
      setPendingStale(false);
      return;
    }
    const elapsed = Date.now() - Date.parse(lastMessage.createdAt);
    if (elapsed >= 60_000) {
      setPendingStale(true);
      return;
    }
    const id = setTimeout(() => setPendingStale(true), 60_000 - elapsed);
    return () => clearTimeout(id);
  }, [showPendingLead, lastMessage]);

  const canSend = !sending && !isPlanning && reply.trim().length > 0;
  const canBuild = !isPlanning && userMessageCount > 0 && !buildClicking;
  const buildButtonShowsSpinner = buildClicking || isPlanning;

  // The transcript is now the SOLE occupant of the scroll region (the advisor
  // moved out to the pinned strip + overlay, Phase 2). PlanMessageList's
  // auto-scroll-to-bottom targets this ref; the strip/progress-strip above and
  // the composer below stay pinned outside it.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Pinned chrome above the transcript: the Stack Strip in the Refine
          view (the stack's always-visible home), swapped for the progress
          pills once a build is in flight. */}
      {!isPlanning ? (
        <PlanStackStrip
          advisor={advisor}
          hasAnsweredFirstRound={hasAnsweredFirstRound}
          onExpand={() => setOverlayOpen(true)}
        />
      ) : (
        <PlanningProgressStrip
          messages={messages}
          completedStages={completedStages}
          startedAt={buildStartedAt}
          stackProvenance={stackProvenance}
          onSetStack={() => setOverlayOpen(true)}
          onCancelBuild={onCancelBuild}
          cancelling={cancelling}
          onRestartStage={onRestartStage}
          restartingStage={restartingStage}
        />
      )}

      {/* Middle region: the transcript scrolls alone. Wrapped in a `relative`
          box so the overlay can cover exactly this region (below the strip,
          above the composer) with no magic offsets. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <PlanMessageList
            messages={messages}
            sessionId={session.id}
            pendingLead={showPendingLead}
            pendingLeadStale={pendingStale}
            scrollContainerRef={scrollRef}
          />
        </div>

        {/* On-demand advisor overlay. Reachable in the Refine view AND from the
            Build strip's "Set stack" nudge — a stack saved mid-build is a
            durable, project-level pin (it can't retro-frame the in-flight
            build, but it drives the next one). It never auto-opens during a
            build: `overlayOpen` only flips true on an explicit click. */}
        {overlayOpen ? (
          <PlanStackOverlay
            advisor={advisor}
            teamTier={teamTier}
            prefs={prefs}
            onPrefsChange={onPrefsChange}
            onClose={() => setOverlayOpen(false)}
          />
        ) : null}
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSend();
        }}
        className={cn(
          "bg-background/80 flex flex-col gap-2 border-t px-6 py-3 backdrop-blur",
          isPlanning && "opacity-60",
        )}
      >
        <Textarea
          rows={3}
          placeholder={
            isPlanning
              ? "Panel is deliberating — input locked until the plan lands."
              : "Reply to the lead…"
          }
          value={reply}
          onChange={(e) => onReplyChange(e.target.value)}
          disabled={isPlanning}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isPlanning) {
              e.preventDefault();
              void onSend();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
            <Kbd className="h-4 text-[11px]">
              {typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac")
                ? "⌘"
                : "Ctrl"}
            </Kbd>
            <span>+</span>
            <Kbd className="h-4 text-[11px]">Enter</Kbd>
            <span>to send</span>
          </p>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Span wrapper so the tooltip still anchors when the button
                    is disabled (Radix Tooltip on a disabled button no-ops). */}
                <span tabIndex={canSend ? -1 : 0}>
                  <Button type="submit" variant="ghost" size="sm" disabled={!canSend}>
                    <Send className="h-3.5 w-3.5" />
                    {sending ? "Sending…" : "Send"}
                  </Button>
                </span>
              </TooltipTrigger>
              {!canSend && !sending ? (
                <TooltipContent>
                  {reply.trim().length === 0 ? "Type a reply first" : "Panel is deliberating"}
                </TooltipContent>
              ) : null}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={canBuild ? -1 : 0}>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={handleBuildClick}
                    disabled={!canBuild}
                  >
                    {buildButtonShowsSpinner ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {buildButtonShowsSpinner ? "Starting build…" : "Build plan"}
                    {!buildButtonShowsSpinner ? <ArrowRight className="h-3.5 w-3.5" /> : null}
                  </Button>
                </span>
              </TooltipTrigger>
              {userMessageCount === 0 ? (
                <TooltipContent>Send at least one message to brief the panel</TooltipContent>
              ) : null}
            </Tooltip>
          </div>
        </div>
      </form>
    </div>
  );
}

// `StageState` is what `StagePill` renders. We derive it from the message
// stream by scanning for `metadata.stage` values that Agent S's Inngest
// functions tag on the system messages:
//
//   • `panel.start` / `consolidator.start` — pill is "running", spinner +
//     elapsed counter ticks.
//   • `panel.done`  / `consolidator.done`  — pill flips green ✓ + final
//     elapsed.
//   • `panel.error` / `consolidator.error` / `*.rollback` / `*.softfail` —
//     pill flips red ✕ + elapsed at the point of failure.
//
// We DON'T hardcode the message content — the rollback wording can drift, but
// `metadata.stage` is the stable contract between Agent S and the UI.
// `runId` is captured from the `*.start` metadata so each pill can render an
// "Open terminal" affordance pointed at /api/runs/<runId>/attach. The runner
// stamps runs.tmux_session_name on claim (Track 2); the attach SSE route
// reads it back. We carry runId on every non-pending state so a stage that
// flipped to done/error still resolves the (possibly still-lingering, post-
// crash) tmux pane for post-mortem viewing.
type StageState =
  | { kind: "pending" }
  | { kind: "running"; startedAt: number; runId: string | null }
  | { kind: "done"; startedAt: number; endedAt: number; runId: string | null }
  | { kind: "error"; startedAt: number; endedAt: number; runId: string | null };

/**
 * Map the realtime message stream into per-stage state. Older messages
 * (before the `metadata.stage` contract landed) fall back to `agent_role`
 * + a content keyword sniff so resumed sessions still light up.
 */
function deriveStageStates(messages: PlanMessage[]): Record<string, StageState> {
  const out: Record<string, StageState> = {
    pm: { kind: "pending" },
    tech_lead: { kind: "pending" },
    devops: { kind: "pending" },
    consolidator: { kind: "pending" },
  };

  function ms(iso: string): number {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : Date.now();
  }

  // Resolve which pill-key a system message refers to. Agent S's inngest.ts
  // tags rows with one of two patterns:
  //   A) panel.<phase> + metadata.panel = "pm" | "tech_lead" | "devops"
  //   B) consolidator.<phase> (no panel field)
  // Plus rollback rows from the new safety net:
  //   C) planPanelStepFn.rollback + metadata.panel = …
  //   D) planConsolidatorFn.rollback
  //   E) planBuildOrchestratorFn.rollback  (apply to consolidator pill —
  //      orchestrator rollback IS the consolidator failing)
  // and the lead-reply rollback we ignore (no stage pill exists for lead).
  function resolveKeyAndPhase(
    stage: string,
    meta: Record<string, unknown>,
  ): { key: string; phase: string } | null {
    const dot = stage.indexOf(".");
    if (dot <= 0) return null;
    const prefix = stage.slice(0, dot);
    const phase = stage.slice(dot + 1);
    // Direct keys (consolidator.*)
    if (prefix in out) return { key: prefix, phase };
    // panel.* — the panel identity lives in metadata.panel.
    if (prefix === "panel") {
      const panel = typeof meta.panel === "string" ? meta.panel : null;
      if (panel && panel in out) return { key: panel, phase };
    }
    // planPanelStepFn.rollback — meta.panel disambiguates.
    if (prefix === "planPanelStepFn") {
      const panel = typeof meta.panel === "string" ? meta.panel : null;
      if (panel && panel in out) return { key: panel, phase };
    }
    if (prefix === "planConsolidatorFn") return { key: "consolidator", phase };
    if (prefix === "planBuildOrchestratorFn") {
      // Orchestrator rollback = the consolidator's downstream effect failed.
      return { key: "consolidator", phase };
    }
    return null;
  }

  for (const m of messages) {
    if (m.role !== "system") continue;
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const rawStage = typeof meta.stage === "string" ? meta.stage : null;

    if (rawStage) {
      const parsed = resolveKeyAndPhase(rawStage, meta);
      if (parsed) {
        const cur = out[parsed.key]!;
        const t = ms(m.createdAt);
        const metaRunId = typeof meta.runId === "string" ? meta.runId : null;
        // Treat error / rollback / softfail / cancelled as the same red ✕
        // terminal state. `start` flips to running unless we already saw a
        // terminal — a late start row would otherwise rewind progress.
        if (parsed.phase === "start") {
          if (cur.kind === "pending")
            out[parsed.key] = { kind: "running", startedAt: t, runId: metaRunId };
        } else if (parsed.phase === "done") {
          const startedAt = cur.kind === "running" ? cur.startedAt : t;
          const runId = cur.kind === "running" ? cur.runId : metaRunId;
          out[parsed.key] = { kind: "done", startedAt, endedAt: t, runId };
        } else if (
          parsed.phase === "error" ||
          parsed.phase === "rollback" ||
          parsed.phase === "softfail" ||
          parsed.phase === "cancelled"
        ) {
          const startedAt = cur.kind === "running" ? cur.startedAt : t;
          const runId = cur.kind === "running" ? cur.runId : metaRunId;
          out[parsed.key] = { kind: "error", startedAt, endedAt: t, runId };
        }
        continue;
      }
      // metadata.stage was present but unresolved (lead rollback, unknown
      // shape, etc) — fall through to the agentRole sniff in case THAT
      // pins it down.
    }

    // Fallback: agent_role + content keyword sniff. Resumed sessions before
    // the runId-in-metadata change won't have a runId here — that's fine,
    // the terminal button is gated on runId presence.
    if (!m.agentRole || !(m.agentRole in out)) continue;
    const cur = out[m.agentRole]!;
    const t = ms(m.createdAt);
    if (/finish|complete|ready|done/i.test(m.content)) {
      const startedAt = cur.kind === "running" ? cur.startedAt : t;
      const runId = cur.kind === "running" ? cur.runId : null;
      out[m.agentRole] = { kind: "done", startedAt, endedAt: t, runId };
    } else if (/error|fail|cancel|rollback|timeout/i.test(m.content)) {
      const startedAt = cur.kind === "running" ? cur.startedAt : t;
      const runId = cur.kind === "running" ? cur.runId : null;
      out[m.agentRole] = { kind: "error", startedAt, endedAt: t, runId };
    } else if (cur.kind === "pending") {
      out[m.agentRole] = { kind: "running", startedAt: t, runId: null };
    }
  }

  return out;
}

/**
 * The Build moment (Phase 4 / spec §6.2): a leading line on the progress strip
 * that names the saved stack the panel is building on, teaching the
 * stack->plan mechanism exactly when the operator would otherwise miss it.
 *   • accepted → "Building on your stack: <services>" (truncating run).
 *   • unrun/skipped/ready → a low-key nudge with a "Set stack" affordance that
 *     opens the advisor overlay.
 * Renders nothing until the advisor self-load settles, so it never flashes the
 * nudge before a pinned stack lands.
 */
function BuildStackLine({
  provenance,
  onSetStack,
}: {
  provenance: StackProvenance;
  onSetStack: () => void;
}) {
  if (!provenance.loaded) return null;

  if (provenance.accepted && provenance.serviceNames.length > 0) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
        <Diamond className="text-primary h-3 w-3 shrink-0 fill-current" aria-hidden />
        <span className="text-foreground shrink-0 font-medium">Building on your stack:</span>
        <span className="text-muted-foreground min-w-0 truncate">
          {provenance.serviceNames.join(" · ")}
        </span>
      </div>
    );
  }

  // unrun / skipped / ready (suggested-but-unsaved) — nothing is pinned, so the
  // panel picks services itself. Nudge + teach.
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[11px]">
      <span>No stack pinned — the panel will choose services itself.</span>
      <button
        type="button"
        onClick={onSetStack}
        className="text-primary hover:text-primary/80 font-medium underline-offset-2 hover:underline"
      >
        Set stack
      </button>
    </div>
  );
}

function PlanningProgressStrip({
  messages,
  completedStages,
  startedAt,
  stackProvenance,
  onSetStack,
  onCancelBuild,
  cancelling,
  onRestartStage,
  restartingStage,
}: {
  messages: PlanMessage[];
  completedStages: Set<string>;
  startedAt: number | null;
  /** Saved-stack provenance (Phase 4) — leads the strip with what the panel is
   *  building on, or nudges when nothing is pinned. */
  stackProvenance: StackProvenance;
  /** Open the advisor overlay from the "no stack pinned" nudge. */
  onSetStack: () => void;
  onCancelBuild: () => void;
  cancelling: boolean;
  onRestartStage: (stage: "panel:pm" | "panel:tech_lead" | "panel:devops" | "consolidator") => void;
  restartingStage: string | null;
}) {
  // Tick the top-line "elapsed" hint every second; cleared on unmount.
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  // Per-stage state derived from the realtime message stream + metadata.
  const stageStates = React.useMemo(() => deriveStageStates(messages), [messages]);

  // Resolve each panel stage to a concrete state once, so the connected track
  // below can both render the pill AND read the upstream stage's state to fill
  // the connector between them. The Set-driven path still flips a pill green
  // when no per-stage metadata landed.
  const resolvedStages = React.useMemo(
    () =>
      PANEL_STAGES.map((stage) => ({
        stage,
        state:
          stageStates[stage.key] ??
          (completedStages.has(stage.key)
            ? ({ kind: "done", startedAt: 0, endedAt: 0, runId: null } as StageState)
            : ({ kind: "pending" } as StageState)),
      })),
    [stageStates, completedStages],
  );

  // Pill-key → restart action token. The PANEL_STAGES `key` field is
  // `pm | tech_lead | devops | consolidator`; the server-action argument
  // shape uses `panel:<lens>` for panels and bare `consolidator` for the
  // merger. Keep the mapping centralised so a future role addition only
  // edits one spot.
  function stageToRestartToken(
    pillKey: string,
  ): "panel:pm" | "panel:tech_lead" | "panel:devops" | "consolidator" | null {
    if (pillKey === "consolidator") return "consolidator";
    if (pillKey === "pm" || pillKey === "tech_lead" || pillKey === "devops") {
      return `panel:${pillKey}` as "panel:pm" | "panel:tech_lead" | "panel:devops";
    }
    return null;
  }

  // Inline terminal-attach state. At most one pill's terminal is open at a
  // time — clicking a different pill's "Open terminal" swaps the panel
  // (matches the RunInspector single-panel pattern). Cleared on unmount or
  // when the user clicks the same pill's button again (toggle).
  const [openTerminal, setOpenTerminal] = React.useState<{ runId: string; label: string } | null>(
    null,
  );
  function handleOpenTerminal(args: { runId: string; label: string }) {
    setOpenTerminal((cur) => (cur && cur.runId === args.runId ? null : args));
  }

  return (
    <div className="bg-muted/20 flex flex-col gap-2 border-b px-6 py-3">
      {/* Phase 4 — the stack provenance the panel is building on, led before the
          deliberation line so the operator sees it exactly when it's applied. */}
      <BuildStackLine provenance={stackProvenance} onSetStack={onSetStack} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
        <span className="text-foreground font-medium">Panel deliberating</span>
        {startedAt ? (
          <span className="text-muted-foreground font-mono">{elapsed}s elapsed</span>
        ) : null}
        <span className="text-muted-foreground">
          · typical: 3-10 min on Claude subscription, &lt;$0.50
        </span>
        <Button
          type="button"
          variant="destructive"
          size="xs"
          className="ml-auto"
          onClick={onCancelBuild}
          disabled={cancelling}
        >
          {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          {cancelling ? "Cancelling…" : "Cancel build"}
        </Button>
      </div>
      {/* Connected progress track — the four panel stages read as one
          progression (the stage rail's language), a thin connector bridging
          each pill to the previous one and filling once that stage completes.
          Every StagePill keeps its terminal / restart affordances. */}
      <div className="flex flex-wrap items-center gap-y-2">
        {resolvedStages.map(({ stage: s, state }, i) => {
          const restartToken = stageToRestartToken(s.key);
          // Terminal button is available when we KNOW the runId AND the pane
          // is plausibly still attachable: running (always) or error (Track 2
          // lingers the pane ~5min after crash so the operator can post-mortem).
          // `done` pills hide it — Track 2 reaps the pane immediately on clean
          // exit. Older sessions whose start row pre-dated the runId-in-meta
          // change won't have a runId; we just hide the button in that case.
          const runId = state.kind === "running" || state.kind === "error" ? state.runId : null;
          const isOpen = openTerminal !== null && runId !== null && openTerminal.runId === runId;
          // The connector fills once the upstream stage has completed.
          const connectorFilled = i > 0 && resolvedStages[i - 1]!.state.kind === "done";
          return (
            <React.Fragment key={s.key}>
              {i > 0 ? (
                <span
                  aria-hidden
                  className={cn(
                    "mx-1 h-px w-5 shrink-0",
                    connectorFilled ? "bg-border" : "bg-border/50",
                  )}
                />
              ) : null}
              <StagePill
                label={s.label}
                state={state}
                onRestart={
                  restartToken && state.kind === "error" ? () => onRestartStage(restartToken) : null
                }
                isRestarting={restartToken !== null && restartingStage === restartToken}
                onOpenTerminal={
                  runId !== null ? () => handleOpenTerminal({ runId, label: s.label }) : null
                }
                terminalIsOpen={isOpen}
              />
            </React.Fragment>
          );
        })}
      </div>
      {openTerminal ? (
        <RunTerminalPanel
          key={openTerminal.runId}
          runId={openTerminal.runId}
          sessionName={`${openTerminal.label} (run ${openTerminal.runId.slice(0, 8)})`}
          onClose={() => setOpenTerminal(null)}
          className="mt-1"
        />
      ) : null}
    </div>
  );
}

/**
 * A single panel-agent progress pill. Three terminal states (done/error) show
 * the elapsed time for the stage; the running state shows the dot-pulse
 * spinner; the pending state stays muted.
 *
 * Sized to drop into the existing pill row — keeps the strip compact.
 *
 * When `onRestart` is provided (only on error state) we render a paired
 * "Restart" button next to the failed pill so the operator can re-fire just
 * that stage without throwing away the whole transcript via "Cancel build".
 */
function StagePill({
  label,
  state,
  onRestart,
  isRestarting,
  onOpenTerminal,
  terminalIsOpen,
}: {
  label: string;
  state: StageState;
  onRestart?: (() => void) | null;
  isRestarting?: boolean;
  /** Click → toggle the inline RunTerminalPanel for this pill's run. Null
   *  when the runId isn't known yet (legacy sessions before the
   *  runId-in-metadata change) or when the pane was reaped (done state). */
  onOpenTerminal?: (() => void) | null;
  terminalIsOpen?: boolean;
}) {
  // Tick a 1-second wallclock so the running-state elapsed counter updates.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (state.kind !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.kind]);

  // Shared terminal toggle — rendered next to the running pill (peek mid-
  // run) and next to the error pill (post-mortem during the linger window).
  const terminalButton = onOpenTerminal ? (
    <Button
      type="button"
      variant={terminalIsOpen ? "secondary" : "outline"}
      size="xs"
      className="h-5 px-1.5 text-[11px]"
      onClick={onOpenTerminal}
      title={
        terminalIsOpen
          ? `Close the ${label} terminal`
          : `Open the live ${label} tmux pane (attach in-browser)`
      }
    >
      <TerminalIcon className="h-2.5 w-2.5" />
      {terminalIsOpen ? "Close" : "Terminal"}
    </Button>
  ) : null;

  if (state.kind === "pending") {
    return (
      <Badge tone="muted" className="text-[11px] opacity-70">
        <span className="bg-muted-foreground/30 h-2 w-2 rounded-full" />
        {label}
      </Badge>
    );
  }
  if (state.kind === "running") {
    const sec = state.startedAt > 0 ? Math.max(0, Math.floor((now - state.startedAt) / 1000)) : 0;
    return (
      <span className="inline-flex items-center gap-1">
        <Badge tone="info" className="text-[11px]">
          <DotsLoader />
          {label}
          {state.startedAt > 0 ? (
            <span className="font-mono opacity-70">{formatStageElapsed(sec)}</span>
          ) : null}
        </Badge>
        {terminalButton}
      </span>
    );
  }
  if (state.kind === "done") {
    const sec = Math.max(0, Math.floor((state.endedAt - state.startedAt) / 1000));
    return (
      <Badge tone="ok" className="text-[11px]">
        <Check className="h-2.5 w-2.5" />
        {label}
        {state.startedAt > 0 ? (
          <span className="font-mono opacity-70">{formatStageElapsed(sec)}</span>
        ) : null}
      </Badge>
    );
  }
  // error
  const sec = Math.max(0, Math.floor((state.endedAt - state.startedAt) / 1000));
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone="danger" className="text-[11px]">
        <X className="h-2.5 w-2.5" />
        {label}
        {state.startedAt > 0 ? (
          <span className="font-mono opacity-70">{formatStageElapsed(sec)}</span>
        ) : null}
      </Badge>
      {terminalButton}
      {onRestart ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-5 px-1.5 text-[11px]"
          onClick={onRestart}
          disabled={!!isRestarting}
          title={`Restart only the ${label} step (keeps the rest of the build)`}
        >
          {isRestarting ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <RotateCcw className="h-2.5 w-2.5" />
          )}
          {isRestarting ? "Restarting…" : "Restart this step"}
        </Button>
      ) : null}
    </span>
  );
}

/** "3m 12s" / "47s" — compact stage-elapsed format. */
function formatStageElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function ClosedState({
  tone,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  tone: "ok" | "muted";
  title: string;
  description: string;
  actionLabel: string;
  actionHref?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full",
          tone === "ok" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
        )}
      >
        {tone === "ok" ? <CheckCircle2 className="h-5 w-5" /> : <Trash2 className="h-5 w-5" />}
      </div>
      <h3 className="font-display text-sm font-semibold">{title}</h3>
      <p className="text-muted-foreground max-w-sm text-xs">{description}</p>
      <div className="mt-2 flex items-center gap-2">
        {actionHref ? (
          <Button asChild variant="primary" size="sm">
            <a href={actionHref}>
              {actionLabel}
              <ExternalLink className="h-3 w-3" />
            </a>
          </Button>
        ) : onAction ? (
          <Button variant="primary" size="sm" onClick={onAction}>
            <RotateCcw className="h-3.5 w-3.5" />
            {actionLabel}
          </Button>
        ) : null}
        {secondaryLabel && onSecondary ? (
          <Button variant="outline" size="sm" onClick={onSecondary}>
            <RotateCcw className="h-3.5 w-3.5" />
            {secondaryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
