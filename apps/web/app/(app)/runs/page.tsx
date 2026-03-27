// Runs index — recent agent runs in the ACTIVE project (scoped via the run's
// ticket → tickets.project_id). Each row links to the Run Inspector at /runs/[id].

import { Suspense } from "react";
import Link from "next/link";
import { Activity, CheckCircle2, Clock, XCircle } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { requireActiveProjectId } from "@/lib/projects/current";
import { supabaseService } from "@/lib/db/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RunsTableSkeleton } from "./runs-list-skeleton";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// Money formatting shared with the rest of the runs feature (RunInspector,
// StepTree): sub-dollar amounts read as cents, anything larger as dollars.
function fmtCents(c: number): string {
  if (c === 0) return "$0";
  if (c < 100) return `${c}¢`;
  return `$${(c / 100).toFixed(2)}`;
}

type RunRow = {
  id: string;
  status: string;
  spent_cents: number | null;
  budget_cents: number | null;
  runner_kind: string | null;
  ticket_id: string | null;
  created_at: string;
};

const STATUS_TONES: Record<
  string,
  { tone: "ok" | "danger" | "info" | "warn" | "muted"; icon: React.ReactNode }
> = {
  done: { tone: "ok", icon: <CheckCircle2 className="h-3 w-3" /> },
  running: { tone: "info", icon: <Activity className="h-3 w-3 animate-pulse" /> },
  failed: { tone: "danger", icon: <XCircle className="h-3 w-3" /> },
  awaiting_human: { tone: "warn", icon: <Clock className="h-3 w-3" /> },
};

// The (app) shell paints first; this page keeps its header static (no awaiting
// at the page level) and streams only the runs table under <Suspense>, so the
// title/description land with the shell while the query resolves (S1).
export default function RunsIndex() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Runs</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Last {PAGE_SIZE} agent runs in this project. Click any row to open the inspector with
            the full step tree.
          </p>
        </div>
      </div>

      <Suspense fallback={<RunsTableSkeleton />}>
        <RunsTable />
      </Suspense>
    </div>
  );
}

async function RunsTable() {
  // Auth + tenant are independent round trips — resolve them together.
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  // Project-first: redirects to onboarding if the tenant has no projects;
  // otherwise scope runs to those whose ticket belongs to the active project.
  const activeProjectId = await requireActiveProjectId(tenantId);
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("runs")
    .select(
      "id, status, spent_cents, budget_cents, runner_kind, ticket_id, created_at, tickets!ticket_id!inner ( project_id )",
    )
    .eq("tenant_id", tenantId)
    .eq("tickets.project_id", activeProjectId)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (error) {
    console.error(`[RunsTable] query failed for tenant ${tenantId}:`, error);
  }

  const rows = (data ?? []) as RunRow[];

  return (
    <>
      {rows.length === 0 ? (
        <div className="bg-card/50 text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center text-sm">
          <Activity className="h-5 w-5" />
          No runs yet. File a ticket on the{" "}
          <Link href="/board" className="font-medium underline-offset-2 hover:underline">
            board
          </Link>{" "}
          and the crew picks it up from Ready.
        </div>
      ) : (
        <div className="bg-card overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Run ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Runner</TableHead>
                <TableHead>Spent / Budget</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const meta = STATUS_TONES[r.status] ?? { tone: "muted" as const, icon: null };
                const spent = r.spent_cents ?? 0;
                const budget = r.budget_cents ?? 0;
                const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
                return (
                  <TableRow key={r.id} className="cursor-pointer">
                    <TableCell>
                      <Link
                        href={`/runs/${r.id}`}
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        {r.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge tone={meta.tone}>
                        {meta.icon}
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge tone="muted">{r.runner_kind ?? "?"}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="text-xs">
                          {fmtCents(spent)} / {fmtCents(budget)}
                        </div>
                        <div className="bg-muted h-1 w-24 overflow-hidden rounded-full">
                          <div
                            className={
                              pct < 70
                                ? "bg-chart-2 h-full"
                                : pct < 95
                                  ? "bg-warning h-full"
                                  : "bg-destructive h-full"
                            }
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(r.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/runs/${r.id}`}>Open inspector</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
