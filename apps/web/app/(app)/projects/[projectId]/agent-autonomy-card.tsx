"use client";

// WI-14 - the per-project controls for `devpilot_create_ticket`.
//
// Deliberately its own card rather than a row on the branch-routing one: this
// is about what agents may DO to the board, not about where their code lands.
// Off by default, and the copy leads with the guarantee that matters - a filed
// ticket sits in Backlog and cannot run until a human moves it.
//
// Two controls, and the second one exists because one instance-wide number
// could not serve both shapes of work. An engineer noticing stray findings
// should stay near three; a DECOMPOSITION ticket - one whose acceptance
// criteria are "file the child tickets for this" - legitimately fans out to
// five or more. On 2026-08-02 one did, filed three, and stranded the rest.
//
// The two field labels below are duplicated as constants in
// `lib/board/agent-ticket.ts` because the refusal copy quotes them verbatim -
// an agent's escalation names the same control the operator is looking at. If
// you reword one, reword both; a test pins the pair.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bot } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { DEFAULT_MAX_TICKETS_PER_RUN } from "@/lib/board/agent-ticket";
import {
  setAgentTicketCreationAction,
  setAgentTicketMaxPerRunAction,
} from "./agent-ticket-actions";

export function AgentAutonomyCard({
  projectId,
  agentTicketCreation,
  agentTicketMaxPerRun,
  inheritedMaxPerRun,
}: {
  projectId: string;
  agentTicketCreation: boolean;
  /** The project's own override, or null when it inherits. */
  agentTicketMaxPerRun: number | null;
  /** What this project WOULD get with no override - i.e. the env rung or the
   *  built-in default, already resolved server-side. Shown as the placeholder
   *  so "blank" is a legible state rather than an unknown one. */
  inheritedMaxPerRun: number;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(agentTicketCreation);
  const [saving, setSaving] = React.useState(false);
  const [capDraft, setCapDraft] = React.useState(
    agentTicketMaxPerRun === null ? "" : String(agentTicketMaxPerRun),
  );
  const [savingCap, setSavingCap] = React.useState(false);

  React.useEffect(() => {
    setEnabled(agentTicketCreation);
  }, [agentTicketCreation]);

  React.useEffect(() => {
    setCapDraft(agentTicketMaxPerRun === null ? "" : String(agentTicketMaxPerRun));
  }, [agentTicketMaxPerRun]);

  async function onToggle(next: boolean) {
    setSaving(true);
    // Optimistic: the switch is the only thing that moves, and we snap it back
    // on failure rather than leaving the operator staring at a stale control.
    setEnabled(next);
    const res = await setAgentTicketCreationAction({ projectId, enabled: next });
    setSaving(false);
    if (!res.ok) {
      setEnabled(!next);
      toast.error(res.error);
      return;
    }
    toast.success(
      next
        ? "Agents can now file backlog tickets for out-of-scope work they find."
        : "Agents can no longer file tickets. They'll report findings in comments instead.",
    );
    router.refresh();
  }

  const capDirty =
    capDraft.trim() !== (agentTicketMaxPerRun === null ? "" : String(agentTicketMaxPerRun));

  async function onSaveCap() {
    const raw = capDraft.trim();
    // Blank is the explicit "inherit" state, not an error - it is how an
    // operator undoes an override without knowing what the instance default is.
    const parsed = raw === "" ? null : Number(raw);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 1)) {
      toast.error("Enter a whole number of 1 or more, or leave it blank to inherit.");
      return;
    }
    setSavingCap(true);
    const res = await setAgentTicketMaxPerRunAction({
      projectId,
      maxPerRun: parsed === null ? null : Math.floor(parsed),
    });
    setSavingCap(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(
      res.maxPerRun === null
        ? `Cleared - this project now inherits the limit of ${inheritedMaxPerRun}.`
        : `One run may now file up to ${res.maxPerRun} ticket(s) in this project.`,
    );
    router.refresh();
  }

  return (
    <div className="bg-card rounded-xl border">
      <div className="flex items-center gap-2 border-b px-5 py-3">
        <Bot className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">Agent autonomy</span>
      </div>

      <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">File tickets for new work</div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            When an agent finds work that is genuinely out of scope for the ticket it&apos;s on, let
            it file a new one instead of silently widening its scope. Filed tickets land in{" "}
            <span className="font-medium">Backlog</span> with no role assigned - they never start a
            run until you move them to Ready. Each run may file only a few, and duplicate titles are
            rejected.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-primary h-4 w-4"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void onToggle(e.target.checked)}
          />
          <span className="text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>

      <div className="flex flex-col gap-2 border-t px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">Tickets one run may file</div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            A hard per-run ceiling. The default suits an engineer noticing the odd stray finding;
            raise it on a planning-heavy board where one ticket is meant to be broken into several
            children, so a decomposition isn&apos;t stranded halfway. Leave blank to inherit{" "}
            <span className="font-medium tabular-nums">{inheritedMaxPerRun}</span>
            {inheritedMaxPerRun === DEFAULT_MAX_TICKETS_PER_RUN
              ? " (the built-in default)"
              : " (set instance-wide by DEVPILOT_MAX_TICKETS_PER_RUN)"}
            .
          </p>
          {/* The field stays usable while filing is off - configuring a board
              before arming it is a reasonable order to work in - but it must
              not read as a live permission, which is how a bare number next to
              a disabled capability scans. */}
          {enabled ? null : (
            <p className="text-muted-foreground mt-1 text-xs italic">
              Not in effect while ticket filing is disabled above.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            aria-label="Tickets one run may file"
            placeholder={String(inheritedMaxPerRun)}
            className="border-input bg-background h-8 w-20 rounded-md border px-2 text-sm tabular-nums"
            value={capDraft}
            disabled={savingCap}
            onChange={(e) => setCapDraft(e.target.value)}
          />
          <button
            type="button"
            className="border-input hover:bg-muted h-8 rounded-md border px-3 text-xs font-medium disabled:opacity-50"
            disabled={savingCap || !capDirty}
            onClick={() => void onSaveCap()}
          >
            {savingCap ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
