"use client";

// Onboarding step 3 — "Connect your runner".
//
// The activation gap this closes: a fresh tenant can file a ticket, but nothing
// runs it until a local runner is heartbeating — and the only signal was the
// small topbar health dot. Here we (a) show the exact host-setup commands and
// (b) drive a live "Waiting → Connected" indicator off the SAME health snapshot
// the dot uses (`useRunnerConnection` → `useSystemHealth`), so the operator sees
// the moment their runner comes online without leaving the page.

import Link from "next/link";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandItem } from "@/components/setup/command-line";
import { useRunnerConnection } from "@/lib/health/use-runner-connected";
import type { SystemHealthSnapshot } from "@/lib/health/types";

export function ConnectRunnerStep({
  initial,
  tenantId,
}: {
  initial: SystemHealthSnapshot;
  tenantId: string;
}) {
  const { status, runner } = useRunnerConnection(initial);
  const connected = status === "connected";

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        DevPilot runs your agents on a local runner using your own Claude subscription. It
        heartbeats to the engine, picks up dispatched tickets, and edits your repo. Set it up once
        on the machine that should do the work:
      </p>

      <ol className="space-y-3">
        <CommandItem
          n={1}
          label="Install the Claude CLI and sign in with your Pro/Max subscription."
          hint="Use claude setup-token instead of login on a headless host."
          commands={["npm install -g @anthropic-ai/claude-code", "claude login"]}
        />
        <CommandItem
          n={2}
          label="Start the runner worker from the repo root."
          hint="Reads its config from apps/web/.env.local — no env file of its own."
          commands={["pnpm --filter @devpilot/runner dev"]}
        />
      </ol>

      <p className="text-muted-foreground text-xs leading-relaxed">
        The runner needs two vars in{" "}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
          apps/web/.env.local
        </code>{" "}
        before it can register:{" "}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
          DEVPILOT_RUNNER_REGISTRATION_KEY
        </code>{" "}
        and{" "}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
          DEVPILOT_RUNNER_TENANT_ID
        </code>{" "}
        (this tenant:{" "}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">{tenantId}</code>).
      </p>

      <LiveIndicator status={status} detail={runner?.detail ?? null} />

      <div className="flex items-center gap-3 pt-1">
        <Button asChild size="sm" variant={connected ? "primary" : "outline"}>
          <Link href="/board">
            {connected ? "File your first ticket" : "Go to the board anyway"}
            <ArrowRight className="h-3.5 w-3.5 opacity-70" />
          </Link>
        </Button>
        {!connected ? (
          <span className="text-muted-foreground text-[11px]">
            You can open the board, but tickets won&apos;t run until your runner connects.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LiveIndicator({ status, detail }: { status: string; detail: string | null }) {
  if (status === "connected") {
    return (
      <div className="border-success/40 bg-success/10 text-success flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Check className="h-4 w-4 shrink-0" />
        <span className="font-medium">Runner connected</span>
        {detail ? <span className="text-success/80 ml-auto text-[11px]">{detail}</span> : null}
      </div>
    );
  }
  const checking = status === "checking";
  return (
    <div className="bg-muted/60 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
      {checking ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      ) : (
        <span className="relative inline-flex h-2.5 w-2.5 shrink-0" aria-hidden>
          <span className="bg-warning absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
          <span className="bg-warning relative inline-flex h-2.5 w-2.5 rounded-full" />
        </span>
      )}
      <span className="font-medium">
        {checking ? "Checking for your runner…" : "Waiting for your runner…"}
      </span>
    </div>
  );
}
