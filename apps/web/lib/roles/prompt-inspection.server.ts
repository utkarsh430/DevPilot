import "server-only";

// Wiring twin for `prompt-inspection.ts` — supplies the service client and the
// role/skill loaders. All decision logic lives in the marker-free module so it
// stays Vitest-loadable; this file only does IO.

import { supabaseService } from "@/lib/db/server";
import { isBuiltinRole, loadRoleConfig, loadRoleConfigWithSkills } from "@/lib/roles/load";
import {
  LEARNINGS_FETCH_LIMIT,
  selectLearningsForDispatch,
  type LearningReader,
} from "@/lib/learning/select";
import {
  LESSON_CAPS,
  composeInspectedPrompt,
  describePromptLayers,
  loadAgentRowForRole,
  reviewerAwarenessApplies,
  toEligibleLessons,
  toEligibleSkills,
  type AgentPromptInspection,
} from "@/lib/roles/prompt-inspection";
import { loadRoleOverlay } from "@/lib/roles/overlay-store";

// Skill eligibility is shown as a LIST, not merged into the displayed prompt,
// so the selection here is made deliberately ticket-independent:
//   • `ticketText: ""` — no ticket to match trigger keywords against.
//   • `enableRank: false` — skip the LLM ranker. It is non-deterministic and
//     ticket-driven; ranking against an empty ticket would invent an order
//     with nothing behind it (and put a Haiku call on a page load).
// What survives is exactly the `targets` gate: skills that name this role, or
// name none. That is a fact about the role, which is what the page claims.
const ELIGIBILITY_TICKET_TEXT = "";
const MAX_ELIGIBLE_SKILLS = 8;

export async function loadAgentPromptInspection(
  tenantId: string,
  slug: string,
): Promise<AgentPromptInspection | null> {
  const config = await loadRoleConfig(tenantId, slug);
  if (!config) return null;

  const source = isBuiltinRole(slug) ? "builtin" : "custom";

  // `loadRoleConfigWithSkills` is the composing entry point in `load.ts`; this
  // is its first caller. We take its `skills` (the tenant-scoped eligibility
  // set) and NOT its composed prompt — that one splices skill bodies in, which
  // is precisely the over-claim this page must not make. The composed prompt we
  // render comes from the same seam with an empty skill list, one line below.
  //
  // Cost of loading the config twice: free for a built-in (a sync map lookup),
  // one extra indexed single-row read for a custom role. Acceptable on an
  // inspector page, and it keeps both call sites honest seams rather than a
  // hand-rolled reimplementation of either.
  const db = supabaseService();
  const [withSkills, agentRow, lessons, overlay] = await Promise.all([
    loadRoleConfigWithSkills({
      tenantId,
      slug,
      ticketText: ELIGIBILITY_TICKET_TEXT,
      enableRank: false,
      topN: MAX_ELIGIBLE_SKILLS,
    }),
    loadAgentRowForRole(db, tenantId, slug),
    // Lessons: the SCOPE filter is what makes this "eligible for this role"
    // (global + user always, role iff the slug matches), and it is exactly what
    // `selectLearningsForDispatch` applies. The per-run CAPS are deliberately
    // lifted here — leaving them on would return a SELECTION of 10, and the
    // page would then present a capped sample as if it were the eligible set.
    // The real caps are surfaced as `lessonCaps` and stated in the copy instead.
    selectLearningsForDispatch({
      // Structural narrow type — same cast the only other caller
      // (`lib/roles/context.ts`) uses, for the same reason: `LearningReader`
      // models just the chain this loader walks so a test fake is forced to
      // honour `.eq`.
      supabase: db as unknown as LearningReader,
      tenantId,
      roles: [slug],
      ticketText: ELIGIBILITY_TICKET_TEXT,
      max: LEARNINGS_FETCH_LIMIT,
      charBudget: Number.MAX_SAFE_INTEGER,
    }),
    // The operator's overlay. Loaded through the same tenant-scoped read the
    // dispatch path uses, so the pane below cannot claim an overlay a run would
    // not receive (or omit one it would).
    loadRoleOverlay(db, tenantId, slug),
  ]);

  const overlayBody = overlay?.body ?? null;

  return {
    slug,
    displayName: agentRow?.name ?? config.displayName,
    source,
    agentSource: agentRow?.source ?? null,
    onSuccessStatus: config.onSuccessStatus,
    modelTier: config.modelTier,
    runnerPolicy: config.runnerPolicy,
    composed: composeInspectedPrompt(config, overlayBody),
    layers: describePromptLayers(config, source, overlayBody),
    reviewerAwarenessApplies: reviewerAwarenessApplies(config),
    overlayBody,
    overlayUpdatedAt: overlay?.updatedAt ?? null,
    eligibleSkills: toEligibleSkills(withSkills?.skills ?? []),
    eligibleLessons: toEligibleLessons(lessons),
    lessonCaps: { ...LESSON_CAPS },
  };
}
