// Phase 1 / M15 — Billing settings page.
//
// Shows:
//   • Hero card: balance, monthly included credit, current overage
//   • Payment method status pill (valid / invalid / none)
//   • Recent meter events (last billed runs)
//   • Educational copy on the 20% markup default + soft cutoff behavior
//   • "Manage payment method" → Stripe Billing Portal redirect
//
// Read-only beyond the portal redirect: card management happens in Stripe.

import { CreditCard, ExternalLink, Info, ReceiptText, Wallet } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { isStripeConfigured, isStripeTestMode } from "@/lib/billing/stripe";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTime } from "@/lib/relative-time";
import { openPortalAction } from "./actions";

export const dynamic = "force-dynamic";

const MARKUP_PCT = Number(process.env.DEVPILOT_BILLING_MARKUP_PCT ?? "20");

function formatDollars(cents: number | null | undefined): string {
  const c = cents ?? 0;
  const sign = c < 0 ? "-" : "";
  return `${sign}$${(Math.abs(c) / 100).toFixed(2)}`;
}

type PmStatus = "valid" | "invalid" | "none" | string;

function pmTone(status: PmStatus): "ok" | "danger" | "muted" {
  if (status === "valid") return "ok";
  if (status === "invalid") return "danger";
  return "muted";
}

function pmLabel(status: PmStatus): string {
  if (status === "valid") return "Card on file";
  if (status === "invalid") return "Payment method invalid";
  return "No payment method";
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Auth + tenant are independent round trips — resolve them together.
  const [, tenantId, params] = await Promise.all([requireUser(), requireTenantId(), searchParams]);
  const supabase = await supabaseServer();

  // The tenant billing row and the meter-event list don't depend on each
  // other — fetch both in parallel.
  const [{ data: tenant }, { data: meterEvents }] = await Promise.all([
    supabase
      .from("tenants")
      .select(
        "name, stripe_customer_id, balance_cents, monthly_included_cents, payment_method_status, billing_period_start",
      )
      .eq("id", tenantId)
      .maybeSingle(),
    supabase
      .from("runs")
      .select("id, spent_cents, billed_at, runner_kind, agents ( name, role )")
      .eq("tenant_id", tenantId)
      .not("billed_at", "is", null)
      .order("billed_at", { ascending: false })
      .limit(15),
  ]);

  const balance = (tenant?.balance_cents as number) ?? 0;
  const included = (tenant?.monthly_included_cents as number) ?? 0;
  const currentOverage = Math.max(0, -balance);
  const pmStatus = (tenant?.payment_method_status as PmStatus) ?? "none";
  const stripeConfigured = isStripeConfigured();
  const testMode = isStripeTestMode();

  // Spend rough percentage within the included bucket. Capped at 100 for the
  // bar; once we tip into overage we show it as fully filled + a danger note.
  const usedThisPeriod = included > 0 ? Math.max(0, included - Math.max(0, balance)) : 0;
  const usedPct = included > 0 ? Math.min(100, Math.round((usedThisPeriod / included) * 100)) : 0;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="bg-muted text-muted-foreground flex h-8 w-8 items-center justify-center rounded-md">
              <Wallet className="h-4 w-4" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight">Billing</h1>
            {testMode ? (
              <Badge tone="warn" className="ml-1">
                Stripe TEST mode
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Usage-based pricing. Each tenant gets{" "}
            <strong className="text-foreground">{formatDollars(included)}</strong> in included
            credits per month. Overage bills at the underlying spend plus a {MARKUP_PCT}% markup.
            Cards are managed through the Stripe Billing Portal.
          </p>
        </div>
      </header>

      {params?.error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive mb-6 rounded-md border px-4 py-3 text-sm">
          Error: {params.error}
        </div>
      ) : null}

      {!stripeConfigured ? (
        <div className="border-warning/30 bg-warning/10 text-warning mb-6 rounded-md border px-4 py-3 text-sm">
          Stripe is not configured for this instance. Set{" "}
          <code className="font-mono">STRIPE_SECRET_KEY</code> (and{" "}
          <code className="font-mono">STRIPE_WEBHOOK_SECRET</code>) to enable billing.
        </div>
      ) : null}

      {/* Hero card — balance, monthly bucket, overage, payment status. */}
      <Card className="mb-6 overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="text-muted-foreground text-sm font-medium">
                Current balance
              </CardTitle>
              <div className="mt-1 flex items-baseline gap-2">
                <span
                  className={
                    "text-4xl font-semibold tracking-tight " +
                    (balance < 0 ? "text-destructive" : "text-foreground")
                  }
                >
                  {formatDollars(balance)}
                </span>
                <span className="text-muted-foreground text-xs">
                  {balance < 0 ? "to be billed" : "credit"}
                </span>
              </div>
            </div>
            <Badge tone={pmTone(pmStatus)} className="gap-1.5">
              <CreditCard className="h-3 w-3" />
              {pmLabel(pmStatus)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Included this month" value={formatDollars(included)} />
            <Stat label="Used (period-to-date)" value={formatDollars(usedThisPeriod)} />
            <Stat
              label="Current overage"
              value={formatDollars(currentOverage)}
              tone={currentOverage > 0 ? "danger" : undefined}
            />
          </div>

          {included > 0 ? (
            <div className="mt-5">
              <div className="text-muted-foreground mb-1 flex items-center justify-between text-xs">
                <span>Included credit used</span>
                <span className="font-mono">
                  {usedPct}%{currentOverage > 0 ? " · overage" : ""}
                </span>
              </div>
              <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className={
                    "h-full transition-all " +
                    (currentOverage > 0
                      ? "bg-destructive"
                      : usedPct < 70
                        ? "bg-chart-2"
                        : usedPct < 95
                          ? "bg-warning"
                          : "bg-destructive")
                  }
                  style={{ width: `${currentOverage > 0 ? 100 : usedPct}%` }}
                />
              </div>
            </div>
          ) : null}

          <form action={openPortalAction} className="mt-6 flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              Customer id:{" "}
              <code className="font-mono">{tenant?.stripe_customer_id ?? "(unprovisioned)"}</code>
            </p>
            <Button type="submit" variant="primary" size="sm" disabled={!stripeConfigured}>
              Manage payment method
              <ExternalLink className="h-3 w-3" />
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Educational card — markup + soft cutoff explainer. */}
      <Card className="border-chart-1/30 bg-chart-1/[0.04] mb-6">
        <CardContent className="flex gap-3 pt-5">
          <Info className="text-chart-1 mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-muted-foreground space-y-2 text-xs">
            <p>
              <strong className="text-foreground">How billing works.</strong> Agents charge their
              run budget against the included monthly credit first. Once you exceed the included
              bucket, every cent of agent spend bills at{" "}
              <strong>spend × (1 + {MARKUP_PCT}%)</strong>. The markup covers infra, tracing, and
              durable retries.
            </p>
            <p>
              <strong className="text-foreground">Soft cutoff.</strong> If your tenant balance drops
              below the configured floor we soft-pause new runs and emit a warning toast on the
              board. In-flight runs continue until their per-run ceiling. Drop a valid card in to
              lift the pause.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Recent meter events. */}
      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ReceiptText className="text-muted-foreground h-4 w-4" />
              <CardTitle className="text-sm">Recent meter events</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Runs flagged <code className="font-mono text-[10px]">billed_at</code> by the
              aggregator.
            </CardDescription>
          </div>
        </CardHeader>
        {(meterEvents?.length ?? 0) === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
            <ReceiptText className="h-5 w-5" />
            No billed runs yet this period.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Runner</TableHead>
                <TableHead className="text-right">Spent</TableHead>
                <TableHead>Billed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(meterEvents ?? []).map((r) => {
                const agent = Array.isArray(r.agents) ? r.agents[0] : r.agents;
                const agentName = (agent?.name as string | undefined) ?? "—";
                const agentRole = (agent?.role as string | undefined) ?? null;
                return (
                  <TableRow key={r.id as string}>
                    <TableCell>
                      <a
                        href={`/runs/${r.id}`}
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        {(r.id as string).slice(0, 8)}
                      </a>
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="text-foreground">{agentName}</span>
                      {agentRole ? (
                        <span className="text-muted-foreground ml-1">({agentRole})</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge tone="muted">{(r.runner_kind as string | null) ?? "?"}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatDollars((r.spent_cents as number) ?? 0)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {relativeTime(r.billed_at as string)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="bg-muted/30 rounded-md border px-4 py-3">
      <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
        {label}
      </div>
      <div
        className={
          "mt-1 text-xl font-semibold " +
          (tone === "danger" ? "text-destructive" : "text-foreground")
        }
      >
        {value}
      </div>
    </div>
  );
}
