// PR 5 — presentation for the agent scoreboard. Server components; no state.
//
// Shaped after `components/metrics/role-usage-table.tsx` so the two read as one
// system: same Card/table chrome, same type scale, tokens only (no raw colors).
// Category accents come from `lib/roles/gallery-meta.ts:categoryAccent`, which is
// the same accent a role carries on the agents gallery.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { categoryAccent } from "@/lib/roles/gallery-meta";
import { cn } from "@/lib/cn";
import { MISTAKE_TYPES, type MistakeType, type RoleScoreRow } from "@/lib/metrics/agent-score";
import type { CategoryLeaderboard } from "@/lib/metrics/agents";
import type { AgentModelScope } from "@/lib/metrics/agent-models.server";
import { AgentModelControl } from "@/components/metrics/agent-model-control";

/** role slug → the projects that role can be given a model on. */
export type AgentModelTargetsByRole = Record<string, AgentModelScope>;

/**
 * The model cell — now also the per-agent model CONTROL.
 *
 * A row is a ROLE (tenant-wide) but the model is configured per PROJECT, so a
 * role that ran across differently-configured projects has no single truthful
 * answer — it says "Mixed" and expands into the per-project list rather than
 * picking one. A wrong label here would drive a bad upgrade decision, which is
 * the one thing this column must not do.
 *
 * The row is `text-xs` inside an 11-13 column horizontally scrolling table, so
 * the control is a popover on this cell, not an inline select.
 */
function ModelCell({ row, scope }: { row: RoleScoreRow; scope: AgentModelScope | undefined }) {
  if (!scope) {
    return <span className="text-muted-foreground text-[10px] italic">unknown</span>;
  }
  return (
    <AgentModelControl
      roleSlug={row.role}
      displayName={row.displayName}
      targets={scope.targets}
      globalTarget={scope.global}
    />
  );
}

/** Short, human labels for the mistake-type columns. */
export const MISTAKE_TYPE_LABEL: Record<MistakeType, string> = {
  verification_fail: "Test/build",
  qa_reject: "QA reject",
  run_failed: "Run failed",
  gate_refusal: "Gate block",
  human_correction: "Redirect",
};

/** The four types that count against the score; `human_correction` never does. */
const SCORING_TYPES: MistakeType[] = MISTAKE_TYPES.filter((t) => t !== "human_correction");

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function scoreTone(score: number): "ok" | "warn" | "danger" {
  if (score >= 0.9) return "ok";
  if (score >= 0.75) return "warn";
  return "danger";
}

/** Slim proportional bar for a row's clean-vs-faulted split. Tokens only. */
function CleanBar({ row }: { row: RoleScoreRow }) {
  const pct = row.totalRuns > 0 ? Math.round(row.rawSuccessRate * 100) : 0;
  return (
    <div
      className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
      role="img"
      aria-label={`${pct}% of runs clean`}
    >
      <div className="bg-success h-full rounded-full" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ScoreRowTable({
  rows,
  emptyHint,
  showRank = true,
  showCategory = false,
  modelTargetsByRole,
}: {
  rows: RoleScoreRow[];
  emptyHint: string;
  showRank?: boolean;
  showCategory?: boolean;
  /** role slug → the projects that role can be given a model on. */
  modelTargetsByRole?: AgentModelTargetsByRole;
}) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground px-4 py-4 text-[11px] italic">{emptyHint}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[64rem] text-xs">
        <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
          <tr className="border-b">
            {showRank && <th className="w-10 py-2 pl-4 text-left font-medium">#</th>}
            {/* Fixed share for the identity column: without it the name, slug and
                category chip wrap differently per row and the rows end up at
                three different heights. */}
            <th className={cn("w-[15rem] py-2 text-left font-medium", showRank ? "" : "pl-4")}>
              Agent
            </th>
            <th className="py-2 pl-4 text-left font-medium">Model</th>
            <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Score</th>
            <th className="w-32 py-2 pl-4 text-left font-medium">Clean runs</th>
            <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Runs</th>
            <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Tickets</th>
            <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Mistakes</th>
            {SCORING_TYPES.map((t) => (
              <th key={t} className="whitespace-nowrap px-2 py-2 text-right font-medium">
                {MISTAKE_TYPE_LABEL[t]}
              </th>
            ))}
            <th className="text-muted-foreground/70 whitespace-nowrap py-2 pl-2 pr-4 text-right font-medium">
              {MISTAKE_TYPE_LABEL.human_correction}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.role} className="border-b last:border-0">
              {showRank && (
                <td className="text-muted-foreground py-2 pl-4 tabular-nums">{i + 1}</td>
              )}
              <td className={cn("py-2", showRank ? "" : "pl-4")}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.displayName}</span>
                  <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
                    {r.role}
                  </code>
                  {showCategory && r.category && (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[10px]",
                        categoryAccent(r.category),
                      )}
                    >
                      {r.category}
                    </span>
                  )}
                </div>
              </td>
              <td className="py-2 pl-4">
                <ModelCell row={r} scope={modelTargetsByRole?.[r.role]} />
              </td>
              <td className="px-2 py-2 text-right">
                <Badge tone={r.ranked ? scoreTone(r.score) : "muted"} className="tabular-nums">
                  {formatPct(r.score)}
                </Badge>
              </td>
              <td className="py-2 pl-4">
                <CleanBar row={r} />
                <div className="text-muted-foreground mt-1 whitespace-nowrap text-[10px] tabular-nums">
                  {r.cleanRuns}/{r.totalRuns} · raw {formatPct(r.rawSuccessRate)}
                </div>
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{r.totalRuns}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.ticketsTouched}</td>
              <td className="px-2 py-2 text-right tabular-nums">
                <span className={r.scoringMistakeCount > 0 ? "text-destructive" : undefined}>
                  {r.scoringMistakeCount}
                </span>
              </td>
              {SCORING_TYPES.map((t) => (
                <td key={t} className="px-2 py-2 text-right tabular-nums">
                  {r.mistakesByType[t] || <span className="text-muted-foreground">·</span>}
                </td>
              ))}
              <td className="text-muted-foreground py-2 pl-2 pr-4 text-right tabular-nums">
                {r.mistakesByType.human_correction || "·"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One category's board: its top agent, then the ranked field, then the rest. */
export function CategoryLeaderboardCard({
  board,
  modelTargetsByRole,
}: {
  board: CategoryLeaderboard;
  modelTargetsByRole?: AgentModelTargetsByRole;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span
            className={cn(
              "rounded-md border px-2 py-0.5 text-[11px]",
              categoryAccent(board.category),
            )}
          >
            {board.category}
          </span>
        </CardTitle>
        {board.top ? (
          <span className="text-muted-foreground text-[11px]">
            Top agent: <span className="text-foreground font-medium">{board.top.displayName}</span>{" "}
            <span className="tabular-nums">{formatPct(board.top.score)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground text-[11px] italic">no ranked agent yet</span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <ScoreRowTable
          rows={board.rows}
          emptyHint="No agent in this category has enough runs to rank yet."
          modelTargetsByRole={modelTargetsByRole}
        />
        {board.unranked.length > 0 && (
          <div className="border-t">
            <p className="text-muted-foreground px-4 pt-3 text-[10px] uppercase tracking-wider">
              Not enough data yet
            </p>
            <ScoreRowTable
              rows={board.unranked}
              emptyHint=""
              showRank={false}
              modelTargetsByRole={modelTargetsByRole}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
