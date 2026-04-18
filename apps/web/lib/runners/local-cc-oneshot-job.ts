// Pure job-payload shape for the local-cc one-shot bridge
// (`local-cc-oneshot.server.ts`). No IO, no `server-only` — importable from
// Vitest, unlike its `.server.ts` twin which touches Supabase + Redis.
//
// THE INCIDENT (2026-08-06): `invokeLocalCcOneShot` inserted a `runs` row
// with a real `ticket_id` for audit purposes, but hardcoded the Redis job's
// `ticketId` to `null` regardless — so a direct `runs` query and the job the
// runner actually popped disagreed about which ticket the run belonged to.
// The runner logged `ticketId=<none>` for a run whose `runs.ticket_id` was
// set, exactly the "workspace precondition" incident's inconsistent-payload
// shape (see `apps/runner/src/workspace-precondition.ts`).
//
// `buildOneShotJobPayload` is the single place that decides the job's
// `ticketId` and `workspacePrepEligible` fields, so the two facts this
// bridge stamps can never drift apart again:
//   - `ticketId` ALWAYS matches the caller's `ticketId` (and therefore the
//     `runs.ticket_id` the caller separately inserts) — audit-truthful.
//   - `workspacePrepEligible` is ALWAYS `false` — this bridge is a pure text
//     call with no role and no resolved project repo, so it can never
//     require or benefit from a workspace, and must not attempt one even via
//     a legacy `ENGINEER_REPO_URL` runner-host fallback (which would race a
//     concurrent producer's live workspace for the SAME ticket).
export type OneShotJobArgs = {
  tenantId: string;
  prompt: string;
  systemPrompt: string;
  ticketId?: string | null;
  modelTier?: string;
};

export type OneShotJobIds = {
  jobId: string;
  runId: string;
  engineUrl: string;
};

export type OneShotJobPayload = {
  jobId: string;
  runId: string;
  tenantId: string;
  iterationIdx: 0;
  prompt: string;
  systemPrompt: string;
  modelTier?: string;
  engineUrl: string;
  ticketId: string | null;
  workspacePrepEligible: false;
};

export function buildOneShotJobPayload(
  args: OneShotJobArgs,
  ids: OneShotJobIds,
): OneShotJobPayload {
  return {
    jobId: ids.jobId,
    runId: ids.runId,
    tenantId: args.tenantId,
    iterationIdx: 0,
    prompt: args.prompt,
    systemPrompt: args.systemPrompt,
    ...(args.modelTier ? { modelTier: args.modelTier } : {}),
    engineUrl: ids.engineUrl,
    // Mirrors the `runs.ticket_id` the caller inserts separately — see header.
    ticketId: args.ticketId ?? null,
    // Never eligible for workspace prep — see header.
    workspacePrepEligible: false,
  };
}
