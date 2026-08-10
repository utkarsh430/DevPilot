// The global agent scoreboard — PR 5 of the "Agent Learning + Scoreboard" system.
//
// Who is the top-performing agent, how often each errs, and a FAIR relative
// ranking. Per-category leaderboards are the real ranking (comparable peers
// only); the cross-role list below them is explicitly labelled as not
// apples-to-apples, because a QA's job is to catch problems and an engineer's is
// to ship.
//
// Page-streaming convention: this component is synchronous so the header paints
// with the shell; the rollup lives in the async <BoardLoader> under a <Suspense>
// sharing one skeleton with loading.tsx.
//
// Tenant isolation: `loadAgentScoreboard` is a SERVICE-ROLE read whose only
// boundary is the required `tenantId` it filters every query by — so the tenant
// here comes from the session (`requireTenantId`), never from a param.

import { Suspense } from "react";
import { CircleAlert, HelpCircle, Info, ListChecks, ShieldCheck, Trophy } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { loadAgentScoreboard } from "@/lib/metrics/agents";
import { agentModelScope, loadAgentModelContext } from "@/lib/metrics/agent-models.server";
import type { AgentModelTargetsByRole } from "@/components/metrics/agent-leaderboard";
import { MIN_RANKED_RUNS, SCORE_PRIOR_ALPHA, SCORE_PRIOR_BETA } from "@/lib/metrics/agent-score";
import { formatEffectiveModel, ladderRung } from "@/lib/llm/claude-model-ladder";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryLeaderboardCard, ScoreRowTable } from "@/components/metrics/agent-leaderboard";
import {
  ProjectModelCard,
  type ProjectModelCardRow,
} from "@/components/metrics/project-model-card";
import { ScoreboardSkeleton } from "./scoreboard-skeleton";

export const dynamic = "force-dynamic";

export default function ScoreboardPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold tracking-tight">Agent scoreboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          How reliably each agent lands its work, ranked within comparable roles. The score is a
          confidence-adjusted success rate, so a lucky two-run agent cannot outrank a proven one.
        </p>
      </header>
      <Suspense fallback={<ScoreboardSkeleton />}>
        <BoardLoader />
      </Suspense>
    </div>
  );
}

async function BoardLoader() {
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  const [board, modelCtx] = await Promise.all([
    loadAgentScoreboard(tenantId),
    loadAgentModelContext(tenantId),
  ]);

  const { totals } = board;
  const cleanPct = totals.runs > 0 ? Math.round((totals.cleanRuns / totals.runs) * 100) : 0;
  // `board.overall` contains ONLY scored role rows — the loader never builds one
  // for an unattributable bucket — so the champion can never be "unassigned".
  const champion = board.overall[0] ?? null;

  // Which agents each project's model change would actually affect. Derived from
  // the projects a role's runs touched, so the confirmation names real agents.
  const allRows = [...board.overall, ...board.needsMoreData];

  // The per-agent control's targets. A scoreboard row is a MEASUREMENT, so its
  // control targets exactly the projects that row's runs actually touched —
  // `row.projectIds`, expanded, never collapsed to one. (The `/agents` gallery
  // makes the other choice deliberately: a card is a configuration surface, so
  // it offers every project.)
  const modelTargetsByRole: AgentModelTargetsByRole = Object.fromEntries(
    allRows.map((r) => [r.role, agentModelScope(r.role, r.projectIds, modelCtx)]),
  );
  const projectModelRows: ProjectModelCardRow[] = board.projectModels.map((p) => ({
    projectId: p.projectId,
    projectName: p.projectName,
    // Through the shared formatter, so this label and the per-agent control's
    // label are the same string for the same resolution.
    currentLabel: formatEffectiveModel(p.effective),
    currentValue: p.effective.kind === "pinned" ? (ladderRung(p.effective.model)?.value ?? "") : "",
    customEndpoint: p.effective.kind === "custom_endpoint",
    affectedAgents: allRows
      .filter((r) => r.projectIds.includes(p.projectId))
      .map((r) => r.displayName),
  }));

  const tiles = [
    {
      label: "Top agent",
      value: champion ? champion.displayName : "—",
      hint: champion
        ? `${(champion.score * 100).toFixed(1)}% · ${champion.totalRuns} runs`
        : `no agent has ${MIN_RANKED_RUNS}+ runs yet`,
      Icon: Trophy,
    },
    {
      label: "Clean runs",
      value: `${cleanPct}%`,
      hint: `${totals.cleanRuns} of ${totals.runs} runs`,
      Icon: ShieldCheck,
    },
    {
      label: "Mistakes",
      value: String(totals.scoringMistakes),
      hint:
        totals.mistakes > totals.scoringMistakes
          ? `+${totals.mistakes - totals.scoringMistakes} redirects (not scored)`
          : "counted against scores",
      Icon: CircleAlert,
    },
    {
      label: "Agents ranked",
      value: `${totals.rankedRoles}/${totals.roles}`,
      hint: `${MIN_RANKED_RUNS}+ runs to be ranked`,
      Icon: ListChecks,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="border-muted">
            <CardContent className="flex flex-col gap-1 p-4">
              <div className="text-muted-foreground flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider">
                <t.Icon className="h-3 w-3" />
                {t.label}
              </div>
              <div className="truncate text-2xl font-semibold tracking-tight">{t.value}</div>
              <div className="text-muted-foreground truncate text-[11px]">{t.hint}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight">
            Leaderboards by role category
          </h2>
          <p className="text-muted-foreground text-xs">
            The real ranking. Agents are compared only against peers doing comparable work — a QA
            agent&rsquo;s job is to catch problems, which is not the same job as shipping a feature.
          </p>
        </div>
        {board.leaderboards.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground p-6 text-sm">
              No agent runs yet. Once tickets start running, leaderboards appear here.
            </CardContent>
          </Card>
        ) : (
          board.leaderboards.map((b) => (
            <CategoryLeaderboardCard
              key={b.category}
              board={b}
              modelTargetsByRole={modelTargetsByRole}
            />
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight">
            Overall &ldquo;most reliable&rdquo;
          </h2>
          <p className="text-muted-foreground text-xs">
            <strong className="text-foreground">Cross-role — not apples-to-apples.</strong> Roles
            face different work with different failure rates, so this list is a workspace-wide view,
            not a fair head-to-head. Use the per-category boards above for that.
          </p>
        </div>
        <Card>
          <CardContent className="p-0">
            <ScoreRowTable
              rows={board.overall}
              emptyHint={`No agent has reached ${MIN_RANKED_RUNS} runs yet.`}
              showCategory
              modelTargetsByRole={modelTargetsByRole}
            />
          </CardContent>
        </Card>
      </section>

      {/* Below the rankings on purpose: this is a SETTING, not a measurement, and
          interleaving it between the two leaderboard sections broke them apart. */}
      <ProjectModelCard rows={projectModelRows} />

      {/* Unattributable runs. Deliberately OUTSIDE every leaderboard and rendered
          as prose rather than a score row: these are real runs that resolve to no
          role, and treating them as a competitor is exactly the bug this page had
          (a synthetic "unassigned" agent sitting at #1 with 99.4%). There is no
          score, no rank and no display name here — and structurally there cannot
          be, because the loader never builds a scored row for them. */}
      {(board.unattributed.runs > 0 || board.excludedSyntheticRuns > 0) && (
        <Card className="border-muted">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <HelpCircle className="h-4 w-4" />
              Runs not attributed to an agent
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground flex flex-col gap-2 p-4 pt-0 text-[11px] leading-relaxed">
            {board.unattributed.runs > 0 && (
              <p>
                <strong className="text-foreground tabular-nums">
                  {board.unattributed.runs} runs
                </strong>{" "}
                across{" "}
                <span className="tabular-nums">{board.unattributed.ticketsTouched} tickets</span>{" "}
                resolved to no role — the run carried neither a fan-out role nor a configured agent,
                so there is nobody to credit or fault. They are real work, so they are shown here,
                but they are <strong className="text-foreground">not an agent</strong> and are never
                ranked.
                {board.unattributed.mistakes > 0 && (
                  <>
                    {" "}
                    <span className="tabular-nums">{board.unattributed.mistakes}</span> mistakes
                    were harvested against them.
                  </>
                )}
              </p>
            )}
            {board.excludedSyntheticRuns > 0 && (
              <p>
                A further{" "}
                <strong className="text-foreground tabular-nums">
                  {board.excludedSyntheticRuns} runs
                </strong>{" "}
                are excluded from this page entirely: they are single internal LLM calls the
                platform makes for itself (lesson extraction, dependency suggestion, plan distill,
                dispatch classifiers). They are plumbing, not agent work, and counting them inflated
                the board.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {board.needsMoreData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Not enough data yet</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <p className="text-muted-foreground px-4 pb-3 text-[11px]">
              Under {MIN_RANKED_RUNS} runs, so these agents are listed but not ranked — a small
              sample says very little either way.
            </p>
            <ScoreRowTable
              rows={board.needsMoreData}
              emptyHint=""
              showRank={false}
              showCategory
              modelTargetsByRole={modelTargetsByRole}
            />
          </CardContent>
        </Card>
      )}

      <Card className="border-muted">
        <CardContent className="text-muted-foreground flex gap-3 p-4 text-[11px] leading-relaxed">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex flex-col gap-1">
            <p>
              <strong className="text-foreground">How the score works.</strong> A run is
              &ldquo;clean&rdquo; when no objective failure is attributed to it. The score is that
              success rate smoothed toward a prior — (clean + {SCORE_PRIOR_ALPHA}) / (runs +{" "}
              {SCORE_PRIOR_ALPHA + SCORE_PRIOR_BETA}) — so small samples sit near the middle and
              proven volume rises above them. Agents under {MIN_RANKED_RUNS} runs are not ranked.
            </p>
            <p>
              <strong className="text-foreground">Redirects never count against an agent.</strong> A
              human correction is shown as context only. Agents are not penalised when you change
              direction or supply new information — those become lessons, not marks.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
