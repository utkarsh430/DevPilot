// Role derivation for the board's swimlane-by-role view.
//
// The board has no first-class "assignee" column, but every ticket carries the
// author of its most recent comment (`lastCommentAuthor`, encoded as
// `${author_type}:${author_id}`). For agent-authored work that `author_id` is
// the role slug, which is exactly the "who currently owns this ticket" signal a
// swimlane wants. Human comments store an email/UUID and system comments store
// "supervision" as their `author_id`, so those collapse into single fixed
// "Human"/"System" lanes keyed off `author_type` rather than leaking one lane
// per email address. This module turns that raw string into a stable lane key,
// a human label (via the role catalog), and a badge tone — all client-safe, so
// it stays scoped to the board components with no server/DB dependency.

import { ROLE_CATALOG } from "@/lib/roles/catalog";
import type { BoardTicket } from "@/components/board/types";

/** Sentinel lane for tickets with no agent/human author yet (fresh backlog). */
export const UNASSIGNED_LANE = "__unassigned__";

export type BoardLane = {
  /** Stable key used for droppable ids and React keys. */
  key: string;
  /** Human-facing lane label. */
  label: string;
  /** Badge/dot tone for the lane, from the catalog-keyed ROLE_TONE below. */
  tone: "info" | "warn" | "danger" | "ok" | "muted" | "violet";
};

// Role → tone, keyed by the canonical ROLE_CATALOG underscore slugs (pm,
// frontend_engineer, dataeng, …). TicketCard has a matching ROLE_TONE map for
// its author badge, keyed by the same catalog slugs - keep the two in step
// when adding roles. Security uses "danger" (red) rather than "warn" (amber)
// so it stays visually distinct from DevOps/SRE.
const ROLE_TONE: Record<string, BoardLane["tone"]> = {
  pm: "info",
  product_manager: "info",
  engineer: "violet",
  frontend_engineer: "violet",
  backend_engineer: "violet",
  fullstack_engineer: "violet",
  qa: "ok",
  security: "danger",
  security_engineer: "danger",
  designer: "info",
  dataeng: "violet",
  data_scientist: "violet",
  sre: "warn",
  devops: "warn",
  cloud_engineer: "warn",
  research: "info",
  human: "muted",
  system: "muted",
};

// slug → displayName from the shared catalog, for pretty lane labels.
const CATALOG_LABEL = new Map<string, string>(
  ROLE_CATALOG.map((entry) => [entry.slug.toLowerCase(), entry.displayName]),
);

/** Extract the lane key from a ticket (lowercased), or null.
 *  Agent authors key off their role slug; human/system authors collapse into
 *  single fixed lanes off their `author_type` (their `author_id` is a per-user
 *  email/UUID or "supervision", not a role). */
function roleKeyOf(ticket: BoardTicket): string | null {
  const raw = ticket.lastCommentAuthor;
  if (!raw) return null;
  const idx = raw.indexOf(":");
  const authorType = (idx >= 0 ? raw.slice(0, idx) : "").trim().toLowerCase();
  if (authorType === "human") return "human";
  if (authorType === "system") return "system";
  const key = (idx >= 0 ? raw.slice(idx + 1) : raw).trim().toLowerCase();
  return key ? key : null;
}

/** Title-case a slug fallback ("release_engineer" → "Release Engineer"). */
function prettify(key: string): string {
  return key
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function laneFor(key: string | null): BoardLane {
  if (!key) {
    return { key: UNASSIGNED_LANE, label: "Unassigned", tone: "muted" };
  }
  const label = CATALOG_LABEL.get(key) ?? prettify(key);
  return { key, label, tone: ROLE_TONE[key] ?? "muted" };
}

/**
 * Group tickets into role lanes, preserving a stable, sensible order: lanes
 * appear in a preferred pipeline order first (PM → Engineer → QA → …), then any
 * other roles alphabetically, with "Unassigned" always sinking to the bottom.
 * Only lanes that actually contain tickets are returned.
 */
export function computeLanes(tickets: ReadonlyArray<BoardTicket>): BoardLane[] {
  const byKey = new Map<string, BoardLane>();
  for (const t of tickets) {
    const lane = laneFor(roleKeyOf(t));
    if (!byKey.has(lane.key)) byKey.set(lane.key, lane);
  }
  const preferred = [
    "pm",
    "product_manager",
    "engineer",
    "frontend_engineer",
    "backend_engineer",
    "fullstack_engineer",
    "qa",
    "security",
    "designer",
  ];
  const rank = new Map(preferred.map((k, i) => [k, i]));
  // Non-role lanes (human/system) sink below the role lanes but above Unassigned.
  const tailRank = new Map([
    ["human", 0],
    ["system", 1],
  ]);
  return Array.from(byKey.values()).sort((a, b) => {
    // Unassigned always last.
    if (a.key === UNASSIGNED_LANE) return 1;
    if (b.key === UNASSIGNED_LANE) return -1;
    const ta = tailRank.get(a.key);
    const tb = tailRank.get(b.key);
    if (ta !== undefined && tb !== undefined) return ta - tb;
    if (ta !== undefined) return 1;
    if (tb !== undefined) return -1;
    const ra = rank.get(a.key);
    const rb = rank.get(b.key);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.label.localeCompare(b.label);
  });
}

/** The lane key a ticket belongs to (matches `computeLanes` keys). */
export function laneKeyOf(ticket: BoardTicket): string {
  return roleKeyOf(ticket) ?? UNASSIGNED_LANE;
}
