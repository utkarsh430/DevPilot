// Agent preferences settings tab — a filtered, editable view of the tenant's
// user-scope standing lessons (`scope='user' AND status='active'`), both
// hand-authored and approved from the review queue. The active tab label is the
// heading, so no page-level <h1> (settings layout convention).
//
// Reads through the RLS-bound `supabaseServer()` client, so tenant isolation is
// carried by RLS (agent_learnings_member_read) — no manual tenant filter needed.
// Writes go through the shared learning actions (service-role, tenant-scoped).

import { requireUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { AgentPreferences, type PreferenceRow } from "./prefs-client";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  body: string;
  category: string;
  created_by: string;
  source_mistake_id: string | null;
};

export default async function AgentPreferencesPage() {
  await requireUser();
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("agent_learnings")
    .select("id, body, category, created_by, source_mistake_id")
    .eq("scope", "user")
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[agent-preferences] query failed:", error);
  }

  const rows: PreferenceRow[] = ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    body: r.body,
    category: r.category,
    // Provenance: the extractor authors 'lesson_extractor'; a hand-authored
    // preference carries the operator's user id and no source mistake.
    provenance: r.created_by === "lesson_extractor" ? "extracted" : "manual",
  }));

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="font-display text-xl font-bold tracking-tight">Agent preferences</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Standing preferences your agents apply across every project — what you actually want, in
          your words. Add them here, or approve suggestions extracted from past corrections in the
          lessons review queue.
        </p>
      </header>
      <AgentPreferences rows={rows} />
    </div>
  );
}
