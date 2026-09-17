import "server-only";

// Wiring for the deploy poll: the real Supabase client, the real Vercel read,
// and the real comment write. `deploy-poll.ts` holds the logic and takes these
// as injected dependencies, which is what makes the poll states testable
// without a network. Same split as `lib/learning/harvest.server.ts`.

import { supabaseService } from "@/lib/db/server";
import { resolveVercelConfig } from "@/lib/vercel/api.server";
import { getVercelDeployment } from "@/lib/vercel/api";
import { DEPLOY_COMMENT_AUTHOR } from "@/lib/vercel/deploy-state";
import type { PollDeps } from "@/lib/vercel/deploy-poll";

export type DeployDepsResult = { ok: true; deps: PollDeps } | { ok: false; reason: string };

/**
 * Build the poll dependencies for a tenant.
 *
 * Returns a refusal rather than throwing when no credential resolves: a
 * disconnected Vercel account is a normal state (the operator may have
 * disconnected mid-build) and the poller's contract is `{ok:false, reason}`, not
 * a red Inngest run.
 */
export async function buildDeployPollDeps(tenantId: string): Promise<DeployDepsResult> {
  const config = await resolveVercelConfig(tenantId);
  const token = (config.token ?? "").trim();
  if (token.length === 0) {
    return { ok: false, reason: "no-vercel-credential" };
  }
  const opts = {
    credential: { token, teamId: config.teamId },
    fetchImpl: (url: string, init: RequestInit) => fetch(url, init),
    timeoutMs: 15_000,
  };
  const db = supabaseService();

  return {
    ok: true,
    deps: {
      db,
      fetchDeployment: (deploymentId: string) => getVercelDeployment(deploymentId, opts),
      postComment: async ({ ticketId, tenantId: tid, body }) => {
        // `author_type: "system"` with a dedicated author id. Deliberately NOT
        // `devpilot_move_ticket`, which `ticket-reconciler.ts` string-matches as
        // a verdict — a deploy notice must never register as an agent rendering
        // a decision on the ticket.
        const { error } = await db.from("comments").insert({
          ticket_id: ticketId,
          tenant_id: tid,
          author_type: "system",
          author_id: DEPLOY_COMMENT_AUTHOR,
          body,
          metadata: { kind: "vercel_deploy" },
        });
        if (error) throw new Error(error.message);
      },
      now: () => new Date().toISOString(),
      // The token is a scrubber needle: a Vercel build error can echo back the
      // request context, and this string lands in a ticket comment agents read.
      secrets: [token],
    },
  };
}
