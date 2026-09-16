// Project-first onboarding — the guided "Get started" screen.
//
// A tenant with zero projects is routed here (by `requireActiveProjectId` on
// the project-scoped pages, e.g. /board). It walks the operator through the
// three prerequisites for real agent work: connect GitHub, create the first
// repo-backed project, then connect a runner so dispatched tickets actually
// execute. Onboarding is only "done" once a project exists AND a runner is
// heartbeating — until then this screen is the guided home, so nobody files a
// ticket into the void with no runner to pick it up. A fully-onboarded tenant
// (project + live runner) is bounced straight to the board.

import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowRight, FolderGit2, Github, Wrench } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { getGithubTokenRow } from "@/lib/github/oauth";
import { loadProjectsForTenant } from "@/lib/projects/load";
import { loadSetupWizardStatus, requiredSetupComplete } from "@/lib/setup/wizard-status";
import { runnerConnectedFromHealth, runnerSatisfied } from "@/lib/onboarding/readiness";
import { Button } from "@/components/ui/button";
import { DevPilotMark } from "@/components/shell/devpilot-mark";
import { HandoffDiagram } from "@/components/roles/handoff-diagram";
import { StepCard } from "@/components/setup/step-card";
import { ConnectRunnerStep } from "./connect-runner-step";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const user = await requireUser();
  const tenantId = await requireTenantId();

  const [projects, setupStatus] = await Promise.all([
    loadProjectsForTenant(tenantId),
    loadSetupWizardStatus(user.id, tenantId),
  ]);
  const health = setupStatus.health;
  // Step 0 only nags the person who can actually fix it: an instance operator
  // on an install that still misses required credentials (Redis, encryption
  // key, runner keys).
  const showInstanceSetup = setupStatus.operator && !requiredSetupComplete(setupStatus);
  const hasProject = projects.length > 0;
  // Shared with the topbar readiness checklist — lib/onboarding/readiness.ts
  // owns the derivation rules (incl. "API-runner tenants never register a
  // local runner, so the runner step is satisfied by default").
  const runnerConnected = runnerConnectedFromHealth(health);
  const expectsLocalRunner = health.expectsLocalRunner;
  const runnerReady = runnerSatisfied({ runnerConnected, expectsLocalRunner });

  // Onboarding is complete once a project exists AND the runner step is
  // satisfied — a live local runner, OR an API-runner tenant that needs none.
  // This is also why an existing, fully-onboarded tenant is never nagged: they
  // satisfy both and go straight to the board. A local-runner tenant without a
  // live runner keeps them here on step 3 instead of bouncing them to a board
  // that can't run work; an API-runner tenant is not stranded here.
  if (hasProject && runnerReady) redirect("/board");

  const githubConnected = Boolean(await getGithubTokenRow(user.id));

  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <div className="mb-8 text-center">
        <DevPilotMark className="mx-auto mb-4 h-8 w-8" />
        <h1 className="font-display text-2xl font-bold tracking-tight">Welcome to DevPilot</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          DevPilot runs a crew of AI agents against your repo - they pick up tickets, hand work off
          role to role, and open changes for your review. Three steps and the first ticket can move.
        </p>
      </div>

      {/* A5 — "meet your crew": one framing beat on the team-of-roles model
          (the same shared diagram the Agents page uses) before the first
          ticket, so the board of roles makes sense on arrival. */}
      <HandoffDiagram
        title="Meet your crew"
        description="Your tickets are worked by a crew of role agents, not one chatbot — each hands the ticket to the next on the board."
        className="mb-8"
      />

      <ol className="space-y-3">
        {showInstanceSetup ? (
          <StepCard
            n={0}
            status="attention"
            title="Finish instance setup"
            description="This install is missing required credentials (secrets key, queue, or runner keys) — tickets can't run until they're in. The setup wizard walks each one with live checks."
            action={
              <Button asChild size="sm" variant="primary">
                <Link href="/settings/setup">
                  <Wrench className="h-3.5 w-3.5" />
                  Open setup
                  <ArrowRight className="h-3.5 w-3.5 opacity-70" />
                </Link>
              </Button>
            }
          />
        ) : null}
        <StepCard
          n={1}
          done={githubConnected}
          title="Connect GitHub"
          description={
            githubConnected
              ? "Connected — agents can clone your repos and push their work for you."
              : "DevPilot needs a GitHub token to clone repos and push the agents' work. Connect once; we reuse it for every project."
          }
          action={
            githubConnected ? null : (
              <Button asChild size="sm" variant="primary">
                <Link href="/settings/github-integration">
                  <Github className="h-3.5 w-3.5" />
                  Connect GitHub
                </Link>
              </Button>
            )
          }
        />
        <StepCard
          n={2}
          done={hasProject}
          disabled={!githubConnected}
          title="Create your first project"
          description={
            hasProject
              ? "Project created — the board, runs, and changes scope to it."
              : "Point DevPilot at a GitHub repo (or create a new one). This is where your agents will work — and what the board, runs, and changes scope to."
          }
          action={
            hasProject ? null : githubConnected ? (
              <Button asChild size="sm" variant="primary">
                {/* next=/welcome returns to onboarding so step 3 (runner) isn't
                    skipped — a freshly created project can't run without one. */}
                <Link href="/projects/new?next=%2Fwelcome">
                  <FolderGit2 className="h-3.5 w-3.5" />
                  New project
                  <ArrowRight className="h-3.5 w-3.5 opacity-70" />
                </Link>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled>
                <FolderGit2 className="h-3.5 w-3.5" />
                New project
              </Button>
            )
          }
        />
        <StepCard
          n={3}
          done={runnerReady}
          disabled={!hasProject}
          title="Connect your runner"
          description={
            !expectsLocalRunner
              ? "Not required - this tenant runs on the API runner, so no local runner is needed."
              : runnerConnected
                ? "A runner is online and heartbeating — dispatched tickets will run."
                : hasProject
                  ? undefined
                  : "Once a project exists, connect a runner so dispatched tickets actually execute."
          }
        >
          {expectsLocalRunner && hasProject && !runnerConnected ? (
            <ConnectRunnerStep initial={health} tenantId={tenantId} />
          ) : null}
        </StepCard>
      </ol>
    </div>
  );
}
