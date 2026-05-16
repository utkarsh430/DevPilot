// Builder index — picks an agent to open in the React Flow editor. When the
// tenant has no custom agents yet, we surface the JD synthesizer as the
// fastest path to a workflow-ready agent.

import Link from "next/link";
import { ArrowRight, Sparkles, Workflow } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type AgentRow = {
  id: string;
  name: string;
  role: string | null;
  config: Record<string, unknown> | null;
};

export default async function BuilderIndex() {
  await requireUser();
  const tenantId = await requireTenantId();
  const supabase = supabaseService();
  const { data } = await supabase
    .from("agents")
    .select("id, name, role, config")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  const agents = (data ?? []) as AgentRow[];

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold tracking-tight">Agent builder</h1>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
          Visual workflow editor backed by the same <code>agents.config</code> JSON the engine reads
          at dispatch time. Pick an agent below to open the canvas.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="border-dashed">
          <CardHeader>
            <div className="bg-muted flex h-9 w-9 items-center justify-center rounded-md">
              <Sparkles className="h-4 w-4" />
            </div>
            <CardTitle>Start from a JD</CardTitle>
            <CardDescription>
              Paste a job description; Sonnet drafts a role, then drop it into a new canvas.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/agents/new">
                Open JD synthesizer <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        {agents.map((a) => {
          const source = (a.config?.source as string | undefined) ?? "builtin";
          return (
            <Link key={a.id} href={`/builder/${a.id}`}>
              <Card className="hover:border-foreground/30 h-full transition-colors">
                <CardHeader>
                  <div className="bg-muted flex h-9 w-9 items-center justify-center rounded-md">
                    <Workflow className="h-4 w-4" />
                  </div>
                  <CardTitle>{a.name}</CardTitle>
                  <CardDescription>
                    <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                      {a.role ?? "—"}
                    </code>{" "}
                    · <span className="text-muted-foreground">{source}</span>
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
