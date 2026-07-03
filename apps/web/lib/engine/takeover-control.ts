// "Take the wheel" — engine→runner control channel.
//
// When an operator clicks "Take the wheel" / "Release control" on the run page,
// the route handler (after pausing/resuming the ticket) LPUSHes a control
// message onto `devpilot:jobs:takeover:control`. The local runner's takeover loop
// (apps/runner/src/takeover-loop.ts) pulls it and opens/closes the interactive
// tmux session. Mirrors the dev-server control channel in dev-server-control.ts.
//
// Hard boundary (same as dev-server-control): the engine NEVER spawns processes
// or reads the runner filesystem — it only writes to Redis. workspace_path and
// repo fields are opaque values round-tripped through the queue for the runner.

import { redis } from "@/lib/cache/redis";

export const TAKEOVER_CONTROL_QUEUE = "devpilot:jobs:takeover:control";

export type TakeoverOpenMessage = {
  kind: "open";
  runId: string;
  tenantId: string;
  ticketId?: string | null;
  workspaceTicketId?: string | null;
  role?: string | null;
  // Recovery fields — only consumed when the runner finds the workspace dir
  // missing (GC'd since the agent ran). An existing workspace is reused as-is
  // so the agent's uncommitted work is preserved. Optional; the runner also
  // falls back to its ENGINEER_REPO_URL env when these are absent.
  repoUrl?: string | null;
  ticketSlug?: string | null;
};

export async function pushTakeoverOpen(msg: TakeoverOpenMessage): Promise<void> {
  await redis().lpush(TAKEOVER_CONTROL_QUEUE, JSON.stringify(msg));
}

export async function pushTakeoverClose(runId: string): Promise<void> {
  await redis().lpush(TAKEOVER_CONTROL_QUEUE, JSON.stringify({ kind: "close" as const, runId }));
}
