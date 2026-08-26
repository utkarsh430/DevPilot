// Ticket-relation grouping — PURE, and deliberately shared.
//
// `GET /api/board/tickets/[id]/relations` (the drawer's Relations panel) and the
// audit export both need to answer the same question: "given the raw
// `ticket_dependencies` rows on both endpoints of a ticket, which refs are
// blockers, which are blocked BY it, which merely reference it?" That grouping
// used to live inline in the route. Two copies of a directionality rule is how
// the two surfaces silently drift — the export would call something a blocker
// that the drawer calls related, and an auditor would have no way to tell which
// was right.
//
// So the rule lives here once, IO-free and unit-tested, and both callers pass
// their own rows in. The route keeps its RLS-bound reads; the export batches.
//
// Directionality (the part worth being explicit about):
//   • a row `(ticket_id: T, blocks_ticket_id: B, relation_type: 'blocked_by')`
//     reads "T is blocked_by B" — B is T's BLOCKER. From B's side the same row
//     reads "B blocks T".
//   • `builds_on` is directional in the same way (T stacks on B).
//   • `related` / `duplicate` are symmetric: they mean the same thing from
//     either endpoint, so both directions are unioned and de-duplicated.
//
// `related`/`duplicate` never gate readiness (AGENTS.md — BLOCKING_RELATION_TYPES);
// this module only groups, it makes no readiness claim of its own.

/** The four relation flavours `ticket_dependencies` can carry. */
export type RelationKind = "blocked_by" | "related" | "duplicate" | "builds_on";

const RELATION_KINDS: readonly RelationKind[] = ["blocked_by", "related", "duplicate", "builds_on"];

export function isRelationKind(v: string): v is RelationKind {
  return (RELATION_KINDS as readonly string[]).includes(v);
}

/** A dependency row as seen from the ticket's OWN side (`ticket_id = <this>`). */
export type OwnDepRow = { blocks_ticket_id: string; relation_type: string };
/** A dependency row as seen from the INVERSE side (`blocks_ticket_id = <this>`). */
export type InverseDepRow = { ticket_id: string; relation_type: string };

/** Grouped ids, by direction. Generic over the ref type the caller resolves. */
export type GroupedRelationIds = {
  /** Blockers: this ticket is blocked_by them. */
  blockedBy: string[];
  /** This ticket blocks them. */
  blocks: string[];
  /** This ticket builds_on them (its parents). */
  buildsOn: string[];
  /** They build_on this ticket (its children). */
  builtOnBy: string[];
  /** Symmetric, both directions unioned. */
  related: string[];
  duplicate: string[];
};

function emptyByKind(): Record<RelationKind, string[]> {
  return { blocked_by: [], related: [], duplicate: [], builds_on: [] };
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Group both directions of a ticket's dependency rows into the six buckets the
 * UI and the export both render. Rows carrying an unknown `relation_type` are
 * DROPPED rather than defaulted into a bucket — a relation flavour added to the
 * DB but not to this vocabulary must not silently start acting like a blocker.
 */
export function groupRelationIds(args: {
  own: readonly OwnDepRow[];
  inverse: readonly InverseDepRow[];
}): GroupedRelationIds {
  const own = emptyByKind();
  const inv = emptyByKind();

  for (const row of args.own) {
    if (!isRelationKind(row.relation_type)) continue;
    own[row.relation_type].push(row.blocks_ticket_id);
  }
  for (const row of args.inverse) {
    if (!isRelationKind(row.relation_type)) continue;
    inv[row.relation_type].push(row.ticket_id);
  }

  return {
    blockedBy: dedupe(own.blocked_by),
    blocks: dedupe(inv.blocked_by),
    buildsOn: dedupe(own.builds_on),
    builtOnBy: dedupe(inv.builds_on),
    related: dedupe([...own.related, ...inv.related]),
    duplicate: dedupe([...own.duplicate, ...inv.duplicate]),
  };
}

/** Every id referenced across both directions — the set to bulk-fetch. */
export function allReferencedIds(args: {
  own: readonly OwnDepRow[];
  inverse: readonly InverseDepRow[];
}): string[] {
  return dedupe([
    ...args.own.map((r) => r.blocks_ticket_id),
    ...args.inverse.map((r) => r.ticket_id),
  ]);
}

/**
 * The relation flavours that actually BLOCK, mirrored from
 * `lib/board/dependencies.ts#BLOCKING_RELATION_TYPES`. Used by the export to
 * decide which refs deserve a resolved land-state (a `related` ref never gates
 * readiness, so classifying it would imply a constraint that does not exist).
 */
export const BLOCKING_GROUPS = ["blockedBy", "buildsOn"] as const;
