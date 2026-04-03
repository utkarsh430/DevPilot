"use client";

// Agent preferences — the editable view of the tenant's standing user-scope
// lessons (`scope='user' AND status='active'`), both hand-authored and approved
// from the review queue. Create / edit / archive over the shared learning
// actions, with an optimistic local list and toast rollback on failure.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Lightbulb, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  archiveLearningAction,
  createUserLessonAction,
  editLearningAction,
} from "@/lib/learning/actions";

export type PreferenceRow = {
  id: string;
  body: string;
  category: string;
  /** Derived provenance label for the badge. */
  provenance: "manual" | "extracted";
};

export function AgentPreferences({ rows: seed }: { rows: PreferenceRow[] }) {
  const router = useRouter();
  const [rows, setRows] = React.useState<PreferenceRow[]>(seed);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [savingId, setSavingId] = React.useState<string | null>(null);

  React.useEffect(() => setRows(seed), [seed]);

  async function onSaveEdit(id: string, body: string) {
    setSavingId(id);
    const res = await editLearningAction({ id, body });
    setSavingId(null);
    if (!res.ok) {
      toast.error(res.error || "Edit failed");
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, body } : r)));
    setEditingId(null);
    toast.success("Preference updated");
    router.refresh();
  }

  async function onArchive(id: string) {
    if (!window.confirm("Archive this preference? Agents will stop applying it.")) return;
    setSavingId(id);
    const res = await archiveLearningAction({ id });
    setSavingId(null);
    if (!res.ok) {
      toast.error(res.error || "Archive failed");
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
    toast.success("Preference archived");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      <CreateForm onCreated={() => router.refresh()} />

      <section>
        <h2 className="mb-3 text-sm font-medium">Active preferences</h2>
        {rows.length === 0 ? (
          <div className="bg-card/50 text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center text-sm">
            <Lightbulb className="h-5 w-5" />
            <p>
              No standing preferences yet. Add one above, or approve a suggestion in the{" "}
              <a href="/learnings" className="font-medium underline-offset-2 hover:underline">
                lessons review queue
              </a>
              .
            </p>
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-4 py-3">
                {editingId === r.id ? (
                  <EditRow
                    initial={r.body}
                    saving={savingId === r.id}
                    onCancel={() => setEditingId(null)}
                    onSave={(body) => void onSaveEdit(r.id, body)}
                  />
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-foreground text-sm">{r.body}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge tone="muted">{r.category}</Badge>
                        <Badge tone={r.provenance === "manual" ? "outline" : "info"}>
                          {r.provenance === "manual" ? "Added manually" : "From a mistake"}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Edit preference"
                        disabled={savingId === r.id}
                        onClick={() => setEditingId(r.id)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Archive preference"
                        disabled={savingId === r.id}
                        onClick={() => void onArchive(r.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [body, setBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [dupWarning, setDupWarning] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    setSaving(true);
    setDupWarning(null);
    const res = await createUserLessonAction({ body: trimmed });
    setSaving(false);
    if (!res.ok) {
      if (res.duplicateBody) {
        setDupWarning(res.duplicateBody);
      } else {
        toast.error(res.error || "Couldn't add preference");
      }
      return;
    }
    setBody("");
    toast.success("Preference added");
    onCreated();
  }

  return (
    <form onSubmit={onSubmit} className="bg-card flex flex-col gap-2 rounded-xl border px-5 py-4">
      <label htmlFor="new-pref" className="text-sm font-medium">
        Add a standing preference
      </label>
      <p className="text-muted-foreground text-xs">
        A short directive your agents should always follow — e.g. &ldquo;Deploy new services to
        Vercel by default.&rdquo; It applies across every project.
      </p>
      <Textarea
        id="new-pref"
        value={body}
        disabled={saving}
        placeholder="When starting a new service, prefer…"
        onChange={(e) => {
          setBody(e.target.value);
          if (dupWarning) setDupWarning(null);
        }}
        className="min-h-[64px]"
      />
      {dupWarning && (
        <p className="text-warning text-xs">
          A very similar preference already exists: &ldquo;{dupWarning}&rdquo;
        </p>
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={saving || body.trim().length === 0}
        >
          <Plus className="h-4 w-4" /> Add preference
        </Button>
      </div>
    </form>
  );
}

function EditRow({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  initial: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const [body, setBody] = React.useState(initial);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        value={body}
        disabled={saving}
        onChange={(e) => setBody(e.target.value)}
        className="min-h-[60px]"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={saving || body.trim().length === 0}
          onClick={() => onSave(body)}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
