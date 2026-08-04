"use client";

// Plans history list — groups sessions by project and renders one row per
// session with a status pill + "Resume" CTA. Reuses <PlanSheet> by holding
// the clicked row's (sessionId, projectId, projectName) at the page level
// instead of mounting one Sheet per row.

import * as React from "react";
import { FolderGit2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlanSheet } from "@/components/plan/PlanSheet";
import { relativeTime } from "@/lib/relative-time";
import type { PlanSession, PlanStatus } from "@/lib/plan/types";

export type PlanHistoryRow = {
  session: PlanSession;
  projectName: string;
};

const STATUS_TONE: Record<PlanStatus, "info" | "warn" | "ok" | "muted" | "danger"> = {
  discussing: "info",
  planning: "warn",
  planned: "warn",
  committed: "ok",
  discarded: "muted",
};
const STATUS_LABEL: Record<PlanStatus, string> = {
  discussing: "Discussing",
  planning: "Building…",
  planned: "Ready to commit",
  committed: "Committed",
  discarded: "Discarded",
};

type ResumeTarget = {
  sessionId: string;
  projectId: string;
  projectName: string;
};

export function PlanHistoryList({ rows }: { rows: PlanHistoryRow[] }) {
  const [resume, setResume] = React.useState<ResumeTarget | null>(null);

  const grouped = React.useMemo(() => {
    const m = new Map<string, { projectName: string; items: PlanHistoryRow[] }>();
    for (const r of rows) {
      const entry = m.get(r.session.projectId);
      if (entry) {
        entry.items.push(r);
      } else {
        m.set(r.session.projectId, {
          projectName: r.projectName,
          items: [r],
        });
      }
    }
    return Array.from(m.entries());
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground rounded-md border border-dashed px-6 py-10 text-center text-sm">
        No planning sessions yet. Open a project and click <strong>Plan tickets</strong> to start
        one.
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-6">
        {grouped.map(([projectId, group]) => (
          <section key={projectId}>
            <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
              <FolderGit2 className="h-3.5 w-3.5" />
              <span className="text-foreground font-medium">{group.projectName}</span>
              <span>·</span>
              <span>
                {group.items.length} session{group.items.length === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="divide-y rounded-md border">
              {group.items.map(({ session: s }) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                      <Badge tone="muted" className="font-mono text-[10px]">
                        {s.stackFlavor}
                      </Badge>
                      {s.spentCents > 0 ? (
                        <Badge tone="info" className="text-[10px]">
                          ${(s.spentCents / 100).toFixed(2)}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm">
                      {s.goalSummary?.trim() || (
                        <span className="text-muted-foreground italic">Untitled plan</span>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-muted-foreground text-[11px]">
                      {relativeTime(s.updatedAt)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setResume({
                          sessionId: s.id,
                          projectId: s.projectId,
                          projectName: group.projectName,
                        })
                      }
                    >
                      {s.status === "committed" || s.status === "discarded" ? "Open" : "Resume"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <PlanSheet
        open={resume !== null}
        onOpenChange={(o) => {
          if (!o) setResume(null);
        }}
        activeProjectId={resume?.projectId ?? ""}
        projectName={resume?.projectName ?? ""}
        initialSessionId={resume?.sessionId ?? null}
      />
    </>
  );
}
