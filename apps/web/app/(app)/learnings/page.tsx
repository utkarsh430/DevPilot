// Lessons — a top-level surface (per the plan, NOT under /settings) with TWO
// switchable views over the tenant's agent_learnings:
//   • the card review stack, walking `candidate` rows one at a time; and
//   • the table, which scans every lesson at once with filters/sort/search and
//     bulk approval — the view that makes a 40-candidate backlog reviewable.
// The view toggle + the table's query live in `learnings-client.tsx`.
//
// This loader fetches ALL statuses (not just `candidate`) because the table can
// filter by status; the card stack is handed the candidate subset by the client,
// so its contract is unchanged.
//
// Page-streaming convention: the header still paints with the shell — reading
// `searchParams` below is a plain URL-param read, not I/O, so it costs nothing
// before the shell flushes; all data-fetching lives in the async <QueueLoader>
// under a <Suspense> boundary sharing one skeleton with loading.tsx.
//
// Reads run through the RLS-bound `supabaseServer()` client, so tenant isolation
// is carried by RLS (agent_learnings_member_read / agent_mistakes_member_read) —
// no manual tenant filter needed on the read. The source-mistake embed uses the
// FK-hint form (`agent_mistakes!source_mistake_id`) to avoid PostgREST ambiguity.
//
// Header alignment follows the view: the card stack is a capped, CENTERED
// reading column (see learnings-client.tsx), and the header centers alongside
// it so the two don't disagree — a left-flush heading over a centered card
// column reads as its own kind of broken. The table view is full-width and the
// header stays left-flush above it, exactly as before. `view` is read from the
// URL here (mirroring learnings-client.tsx's own initial-state read) so the
// header's alignment is correct on first paint AND after a toggle, since
// `router.replace` in the client re-renders this Server Component with the new
// `searchParams`.

import { Suspense } from "react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { getLearningAutoApprove } from "@/lib/learning/auto-approve.server";
import { formatTicketKey } from "@/lib/board/ticket-key";
import { cn } from "@/lib/cn";
import {
  isLearningStatus,
  type LessonTableRow,
  toLessonConfidence,
} from "@/lib/learning/table-view";
import { LearningsClient } from "./learnings-client";
import { ReviewQueueSkeleton } from "./learnings-skeleton";

export const dynamic = "force-dynamic";

const QUEUE_LIMIT = 500;

export default async function LearningsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const params = await searchParams;
  const isCardsView = params.view !== "table";

  return (
    <div className="mx-auto w-full max-w-[1500px] px-6 py-8">
      <header className={cn("mb-6 max-w-3xl", isCardsView && "mx-auto")}>
        <h1 className="font-display text-2xl font-bold tracking-tight">Lessons</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Lessons the system extracted from agent mistakes. Approve the ones worth keeping, reject
          the noise. Approved lessons become standing guidance injected into every future agent run.
        </p>
      </header>
      <Suspense fallback={<ReviewQueueSkeleton />}>
        <QueueLoader />
      </Suspense>
    </div>
  );
}

type MistakeEmbed = {
  id: string;
  type: string;
  evidence: Record<string, unknown> | null;
  role: string;
  run_id: string | null;
  ticket_id: string | null;
};

type LearningRow = {
  id: string;
  scope: string;
  role_slug: string | null;
  category: string;
  body: string;
  status: string;
  created_at: string;
  // Graded asynchronously by the confidence grader, so NULLABLE: null means
  // "not yet graded", never "low". Both views render that state explicitly and
  // confidence-based bulk approval structurally skips it.
  confidence: string | null;
  confidence_reason: string | null;
  source_mistake_id: string | null;
  // PostgREST returns an embedded to-one as an object (or null); typed as
  // object-or-array for a defensive normalise at the call site.
  agent_mistakes: MistakeEmbed | MistakeEmbed[] | null;
};

async function QueueLoader() {
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("agent_learnings")
    .select(
      "id, scope, role_slug, category, body, status, created_at, confidence, " +
        "confidence_reason, source_mistake_id, " +
        "agent_mistakes!source_mistake_id ( id, type, evidence, role, run_id, ticket_id )",
    )
    .order("created_at", { ascending: true })
    .limit(QUEUE_LIMIT);

  if (error) {
    // Never swallow a Supabase error silently (AGENTS.md).
    console.error(`[learnings] candidate query failed for tenant ${tenantId}:`, error);
  }

  const rows = (data ?? []) as unknown as LearningRow[];

  // A to-one FK embed returns an object, but normalise defensively in case
  // PostgREST hands back a single-element array.
  const mistakeOf = (r: LearningRow): MistakeEmbed | null =>
    Array.isArray(r.agent_mistakes) ? (r.agent_mistakes[0] ?? null) : r.agent_mistakes;

  // Resolve ticket keys for the deep-links in one batched RLS-bound read.
  const ticketIds = Array.from(
    new Set(rows.map((r) => mistakeOf(r)?.ticket_id).filter((x): x is string => !!x)),
  );
  const ticketKeyById = new Map<string, string>();
  if (ticketIds.length > 0) {
    const { data: tks, error: tkErr } = await supabase
      .from("tickets")
      .select("id, ticket_number")
      .in("id", ticketIds);
    if (tkErr) console.error(`[learnings] ticket-key lookup failed:`, tkErr);
    for (const t of (tks ?? []) as { id: string; ticket_number: number | null }[]) {
      ticketKeyById.set(t.id, formatTicketKey(t.ticket_number, t.id));
    }
  }

  const lessons: LessonTableRow[] = rows.map((r) => {
    const m = mistakeOf(r);
    return {
      id: r.id,
      scope: (r.scope === "global" || r.scope === "role" || r.scope === "user"
        ? r.scope
        : "global") as LessonTableRow["scope"],
      roleSlug: r.role_slug,
      category: r.category,
      body: r.body,
      // An unrecognised status reads as `candidate` — it must land somewhere a
      // human still sees it, never silently as `active`.
      status: isLearningStatus(r.status) ? r.status : "candidate",
      createdAt: r.created_at,
      confidence: toLessonConfidence(r.confidence),
      confidenceReason: r.confidence_reason,
      mistake: m
        ? {
            id: m.id,
            type: m.type,
            evidenceSummary: summarizeEvidence(m.evidence),
            role: m.role,
            runId: m.run_id,
            ticketId: m.ticket_id,
            ticketKey: m.ticket_id ? (ticketKeyById.get(m.ticket_id) ?? null) : null,
          }
        : null,
    };
  });

  const autoApprove = await getLearningAutoApprove(tenantId);

  return <LearningsClient rows={lessons} autoApprove={autoApprove} />;
}

/**
 * Compact, human-readable one-liner(s) from a mistake's (already-redacted at
 * harvest) evidence blob for the context panel. Prefers known fields; falls back
 * to a truncated JSON. Rendered as plain text (React escapes it) — it is
 * untrusted content shown to a human, not an injection sink.
 */
function summarizeEvidence(evidence: Record<string, unknown> | null): string {
  if (!evidence) return "";
  const parts: string[] = [];
  const push = (label: string, key: string) => {
    const v = evidence[key];
    if (typeof v === "string" && v.trim().length > 0) parts.push(`${label}: ${v.trim()}`);
    else if (typeof v === "number") parts.push(`${label}: ${v}`);
  };
  push("command", "command");
  push("exit", "exitCode");
  push("output", "outputTail");
  push("comment", "comment");
  push("summary", "summary");
  push("reason", "reason");
  const text = parts.join("\n");
  if (text.length > 0) return text.slice(0, 1200);
  try {
    return JSON.stringify(evidence).slice(0, 1200);
  } catch {
    return "";
  }
}
