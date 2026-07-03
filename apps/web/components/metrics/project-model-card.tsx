"use client";

// The PROJECT-scope model control — "every agent on this project runs this".
//
// It used to be the only model control there was, and its copy said so in as
// many words ("DevPilot has no per-agent model setting"). That is no longer true:
// an agent's model can now be set per project from `/agents` and from the
// scoreboard's own Model column. So this card is now framed as the BROAD lever —
// the default every agent on the project inherits — and points at the narrower
// one, rather than denying it exists.
//
// The select + Apply + dirty/saved/error block that used to be inlined here is
// the shared `ModelPicker`; this file keeps only what is genuinely project-scoped
// (which agents are affected, and the confirmation copy that names them).

import { Cpu } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { setProjectClaudeModelAction } from "@/lib/metrics/model-actions";
import { CUSTOM_ENDPOINT_REASON } from "@/lib/metrics/agent-model-view";
import { ModelPicker, ladderLabel } from "./model-picker";

export type ProjectModelCardRow = {
  projectId: string;
  projectName: string;
  currentLabel: string;
  /** Current stored ladder value, "" when nothing is pinned. */
  currentValue: string;
  /** True when the project runs on a non-Claude endpoint — control disabled. */
  customEndpoint: boolean;
  /** Display names of the agents whose runs landed in this project. */
  affectedAgents: string[];
};

export function ProjectModelCard({ rows }: { rows: ProjectModelCardRow[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Cpu className="h-4 w-4" />
          Model by project
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-0 p-0">
        <p className="text-muted-foreground px-4 pb-3 text-[11px] leading-relaxed">
          The project&rsquo;s <strong className="text-foreground">default model</strong>: every
          agent working on it runs this unless that agent has its own model set for this project. To
          move just one agent, use the <strong className="text-foreground">Model</strong> column on
          the boards above (or the agent&rsquo;s card on the Agents page). &ldquo;Account
          default&rdquo; means nothing is pinned and runs use whatever your Claude account defaults
          to.
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-4 pb-4 text-[11px] italic">
            No projects in this workspace yet.
          </p>
        ) : (
          <div className="border-t">
            {rows.map((row) => (
              <ProjectModelRow key={row.projectId} row={row} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectModelRow({ row }: { row: ProjectModelCardRow }) {
  return (
    <div className="flex flex-col gap-2 border-b p-4 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{row.projectName}</div>
          <div className="text-muted-foreground text-[11px]">
            Currently: <span className="text-foreground font-medium">{row.currentLabel}</span>
          </div>
        </div>
        <ModelPicker
          id={`model-${row.projectId}`}
          currentValue={row.currentValue}
          ariaLabel={`Default model for ${row.projectName}`}
          disabled={row.customEndpoint}
          disabledReason={CUSTOM_ENDPOINT_REASON}
          onApply={(model) => setProjectClaudeModelAction({ projectId: row.projectId, model })}
          renderPreview={(next) => (
            <>
              Applying moves every agent on <strong>{row.projectName}</strong> without its own model
              from <strong>{row.currentLabel}</strong> to <strong>{ladderLabel(next)}</strong>.
            </>
          )}
        />
      </div>

      {row.affectedAgents.length > 0 && (
        <p className="text-muted-foreground text-[11px]">
          Affects {row.affectedAgents.length} agent
          {row.affectedAgents.length === 1 ? "" : "s"} on this project:{" "}
          <span className="text-foreground">{row.affectedAgents.join(", ")}</span>
        </p>
      )}
    </div>
  );
}
