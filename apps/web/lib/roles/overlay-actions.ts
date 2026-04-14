"use server";

// Server actions for the operator prompt overlay (`/agents/[slug]`).
//
// Lives in `lib/` rather than under `app/` for the same reason
// `lib/automation/actions.ts` and `lib/stack/advisor-actions.ts` do: the editor
// is a client component that the page mounts, and keeping the action beside its
// store module keeps the write path in one directory.
//
// ── "use server" async-only-export rule (respected) ────────────────────────
// EVERY exported symbol here is a browser-callable endpoint, so every one is an
// async server action that derives `tenantId` from the SESSION
// (`requireTenantId()`), never a helper taking a raw tenantId. The raw-tenantId
// DB logic lives in the plain `lib/roles/overlay-store.ts` module (imported,
// never re-exported), which is why this file exposes no tenant-taking function
// an attacker could call with someone else's id.
//
// ── Gating ─────────────────────────────────────────────────────────────────
// Plain `requireUser()` + `requireTenantId()` — NOT `isInstanceOperator`, which
// checks the INSTALL's first tenant and misfires for every other workspace.
// Writing an overlay is a human action: there is no MCP tool, nothing in
// `DEVPILOT_BOARD_TOOLS`, and no runner path that reaches either of these.
//
// ── Validation happens HERE, not in the browser ────────────────────────────
// The editor runs `checkOverlayBody` for live feedback, but a forged POST never
// touches that code, so the action re-runs the same pure check server-side and
// stores only what IT sanitised. The client's copy is a convenience; this one is
// the rule.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { checkOverlayBody, OVERLAY_MAX_CHARS, type OverlayViolation } from "@/lib/roles/overlay";
import { clearRoleOverlay, upsertRoleOverlay } from "@/lib/roles/overlay-store";
import { loadRoleConfig } from "@/lib/roles/load";
import {
  ASSIST_REQUEST_MAX_CHARS,
  runOverlayAssist,
  type OverlayAssistOutcome,
} from "@/lib/roles/overlay-assist";
import { defaultAssistDeps } from "@/lib/roles/overlay-assist.server";

export type OverlayActionResult =
  | { ok: true }
  | { ok: false; error: string; violations?: OverlayViolation[] };

// The role slug shape every other slug-keyed surface accepts. Bounded so a
// hostile client cannot make us scan on a megabyte of text.
const SlugInput = z.string().min(1).max(128);

/**
 * A request-size sanity ceiling, NOT the overlay cap. It is set far above
 * `OVERLAY_MAX_CHARS` on purpose: an over-cap body must reach
 * `checkOverlayBody` so the operator gets the real "you are 46,000 characters
 * over, trim it" message rather than a flat "invalid input" — and pasting a
 * whole PRD into the box is exactly the case that produces the most confusing
 * error, so it is the case that most needs the good one. Above this ceiling we
 * still answer with the same honest message rather than Zod's.
 */
const REQUEST_SIZE_CEILING = 1_000_000;

const SaveInput = z.object({
  roleSlug: SlugInput,
  body: z.string(),
});

const ClearInput = z.object({ roleSlug: SlugInput });

function revalidateOverlaySurfaces(slug: string) {
  revalidatePath(`/agents/${slug}`);
  revalidatePath("/agents");
}

/** Save (create or replace) the tenant-wide overlay for a role. */
export async function saveAgentOverlayAction(input: {
  roleSlug: string;
  body: string;
}): Promise<OverlayActionResult> {
  const parsed = SaveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  // Answered before the guard rather than by it, so a body large enough to be
  // worth short-circuiting still gets a message about LENGTH.
  if (parsed.data.body.length > REQUEST_SIZE_CEILING) {
    return {
      ok: false,
      error:
        `Those instructions are ${parsed.data.body.length.toLocaleString()} characters; the limit ` +
        `is ${OVERLAY_MAX_CHARS.toLocaleString()}. They are added to every run of this agent.`,
    };
  }

  const user = await requireUser();
  const tenantId = await requireTenantId();

  // Server-side re-check on the SERVER'S sanitisation — the stored body is the
  // one this returned, never the one the browser sent.
  const checked = checkOverlayBody(parsed.data.body);
  if (!checked.ok) {
    return {
      ok: false,
      error: "These instructions need a change before they can be saved.",
      violations: checked.violations,
    };
  }

  const res = await upsertRoleOverlay(supabaseService(), {
    tenantId,
    roleSlug: parsed.data.roleSlug,
    body: checked.body,
    updatedBy: user.id,
  });
  if (!res.ok) return { ok: false, error: res.error };

  revalidateOverlaySurfaces(parsed.data.roleSlug);
  return { ok: true };
}

// ── Phase 3: the plain-English assist ──────────────────────────────────────

const ImproveInput = z.object({
  roleSlug: SlugInput,
  /** What the operator typed. UNTRUSTED — see `overlay-assist.ts`. */
  request: z.string().max(REQUEST_SIZE_CEILING),
  /** The editor's live text, which may include unsaved edits. His own. */
  currentOverlay: z.string().max(REQUEST_SIZE_CEILING),
});

/**
 * Propose an improved overlay from a plain-English request.
 *
 * WRITES NOTHING, and that is the design rather than an omission: the operator
 * reads the proposal, edits it if he wants, and presses Save — which is
 * `saveAgentOverlayAction` above, the only writer in this feature, and it
 * re-runs `checkOverlayBody` on whatever he finally accepted. So the model's
 * output is checked on the way out of the assist AND again on the way into the
 * database, and there is no path from here to any table at all.
 *
 * The BASE PROMPT is resolved server-side from the tenant's own role
 * (`loadRoleConfig`, whose custom branch is `.eq("tenant_id", …)`-scoped) and is
 * never accepted from the client. A client-supplied base would let a forged POST
 * feed arbitrary text into the model as trusted read-only context, which is the
 * one input here where trust actually matters — the request and the current
 * overlay are the operator's own text either way.
 */
export async function improveAgentOverlayAction(input: {
  roleSlug: string;
  request: string;
  currentOverlay: string;
}): Promise<OverlayAssistOutcome> {
  const parsed = ImproveInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Keep the request under ${ASSIST_REQUEST_MAX_CHARS.toLocaleString()} characters.`,
    };
  }

  await requireUser();
  const tenantId = await requireTenantId();

  const config = await loadRoleConfig(tenantId, parsed.data.roleSlug);
  if (!config) return { ok: false, error: "That agent doesn't exist in this workspace." };

  return runOverlayAssist(defaultAssistDeps(tenantId), {
    basePrompt: config.systemPrompt,
    // Phase 4 — labelled inviolable in the prompt, and read from the SAME
    // server-side config as the base. There is no client field for it, for the
    // same reason there is none for `basePrompt`.
    safetyContract: config.safetyContract,
    currentOverlay: parsed.data.currentOverlay,
    request: parsed.data.request,
  });
}

/**
 * Clear the overlay — THE RESET, and it is one call with nothing to reconstruct.
 * The shipped prompt was never copied anywhere, so removing this row restores it
 * exactly.
 */
export async function clearAgentOverlayAction(input: {
  roleSlug: string;
}): Promise<OverlayActionResult> {
  const parsed = ClearInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  await requireUser();
  const tenantId = await requireTenantId();

  const res = await clearRoleOverlay(supabaseService(), tenantId, parsed.data.roleSlug);
  if (!res.ok) return { ok: false, error: res.error };

  revalidateOverlaySurfaces(parsed.data.roleSlug);
  return { ok: true };
}
