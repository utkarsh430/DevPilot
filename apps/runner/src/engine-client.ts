// HTTP helpers for the worker → engine calls.

import { env } from "./env.js";

const headers = () => ({
  "Content-Type": "application/json",
  "x-devpilot-runner-key": env.REGISTRATION_KEY,
  // Phase 5 — identify this runner's tenant so the engine can resolve the
  // tenant's per-tenant platform-secret overrides (see config-client.ts and
  // GET /api/runners/config). Harmless on the existing routes, which ignore it.
  "x-devpilot-runner-tenant": env.TENANT_ID,
});

export async function registerRunner(): Promise<{ runnerId: string; tenantId: string }> {
  const res = await fetch(`${env.ENGINE_URL}/api/runners/register`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      tenantId: env.TENANT_ID,
      name: env.NAME,
      capabilities: ["text", "file_edit", "bash", "git"],
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { runnerId: string; tenantId: string };
}

export async function heartbeat(
  runnerId: string,
  status: "idle" | "busy" = "idle",
  /**
   * Track 2 — the most recently active headless tmux session this runner is
   * wrapping a `claude -p` step inside. Null when no tmux-wrapped run is
   * active (idle, or the host doesn't have tmux installed and the runner
   * fell back to direct child_process spawn). The engine stamps this onto
   * `runs.tmux_session_name` for the runner's current in-flight run so the
   * UI can render `tmux attach -t <name>`.
   */
  tmuxSession: string | null = null,
): Promise<void> {
  const res = await fetch(`${env.ENGINE_URL}/api/runners/${runnerId}/heartbeat`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ status, tmuxSession }),
  });
  if (!res.ok) {
    // Non-fatal; log and continue.
    console.warn(`[devpilot-runner] heartbeat failed: ${res.status}`);
  }
}

export type StepResultBody = {
  jobId: string;
  ok: boolean;
  result?: {
    text: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason?: string;
    modelId?: string;
  };
  error?: string;
  /**
   * Phase 1 / M0 — Engineer git workspace. The absolute path on the runner host
   * where this step's `claude -p` ran (cwd). `null` when no workspace was
   * prepared (e.g. job carries no ticketId, or `ENGINEER_REPO_URL` is unset).
   */
  workspacePath: string | null;
};

export async function postStepResult(runId: string, body: StepResultBody): Promise<void> {
  const res = await fetch(`${env.ENGINE_URL}/api/runs/${runId}/step-result`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`step-result failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Stamp `runs.runner_id` with this runner's id so the engine's runner-watchdog
 * can correctly attribute in-flight runs when the runner stops heartbeating.
 *
 * Best-effort: a 404 / 409 / network error is logged and swallowed because
 * the job has already been rpop'd from Redis and we can still execute it.
 * The only consequence of a failed claim is that the watchdog won't auto-pause
 * the owning ticket if THIS runner crashes mid-flight — the 15-min stale-run
 * reaper still catches it as a fallback.
 *
 * Returns true when the claim landed (or was already owned by this runner),
 * false otherwise. Callers don't need to act on the return value today.
 */
export async function claimRun(
  runId: string,
  runnerId: string,
  /**
   * Track 2 — when set, also stamp `runs.tmux_session_name` so the UI can
   * render `tmux attach -t <name>` immediately, without waiting for the next
   * heartbeat tick. Safe to call repeatedly for the same run; the route is
   * idempotent on this field. */
  tmuxSession?: string | null,
): Promise<boolean> {
  try {
    const res = await fetch(`${env.ENGINE_URL}/api/runs/${runId}/claim`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ runnerId, tmuxSession: tmuxSession ?? null }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[devpilot-runner] claim run=${runId} failed: ${res.status} ${body.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `[devpilot-runner] claim run=${runId} network failure: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Phase 3 (ticket screenshots) — fetch fresh signed download URLs for this run's
 * ticket image attachments. The engine derives the ticket + tenant from the run
 * row server-side; we pass ONLY the runId (in the path) and our registration
 * key, so this can never reach another run's / tenant's images. Best-effort: a
 * failure returns [] and the agent runs on the ticket text alone.
 */
export type RunAttachmentDescriptor = {
  id: string;
  mime: string;
  bytes: number;
  filename: string;
  url: string;
};

export async function fetchRunAttachments(runId: string): Promise<RunAttachmentDescriptor[]> {
  try {
    const res = await fetch(`${env.ENGINE_URL}/api/runs/${runId}/attachments`, {
      method: "GET",
      headers: headers(),
    });
    if (!res.ok) {
      console.warn(
        `[devpilot-runner] fetch attachments run=${runId} failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
      return [];
    }
    const body = (await res.json()) as { attachments?: RunAttachmentDescriptor[] };
    return Array.isArray(body.attachments) ? body.attachments : [];
  } catch (err) {
    console.warn(
      `[devpilot-runner] fetch attachments run=${runId} network failure: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * How long an artifact upload may take before it is abandoned. Bounded because
 * this runs on the runner's job path (after the step result is already posted,
 * so it delays nothing the engine is waiting on) and Node's undici default would
 * otherwise let a stalled engine hold the slot for ~300s.
 */
const ARTIFACT_UPLOAD_TIMEOUT_MS = 30_000;

/**
 * Ship ONE screenshot the agent captured during a step to the engine, which
 * stores it against `run_steps.idx = stepIdx` for the operator to see.
 *
 * One call per image, not a batch: a partial failure then names the exact file
 * and leaves the others stored (the same reasoning as the Vercel env push).
 *
 * We send NO tenant and NO storage key — the engine derives the tenant from the
 * run row, so a compromised runner cannot file an image against another
 * workspace's run inspector.
 *
 * Best-effort by contract: returns false on any refusal or network failure and
 * never throws. Losing a screenshot is a degraded run, never a failed one.
 */
export async function postRunArtifact(args: {
  runId: string;
  stepIdx: number;
  filename: string;
  bytes: Buffer;
  sequence: number;
  capturedTotal: number;
  capturedAt: string;
}): Promise<boolean> {
  try {
    const form = new FormData();
    // Uint8Array copy: Buffer is a Node view over a possibly-pooled ArrayBuffer,
    // and handing that straight to Blob can carry neighbouring bytes.
    form.append(
      "file",
      new Blob([new Uint8Array(args.bytes)], { type: "application/octet-stream" }),
      args.filename,
    );
    form.append("filename", args.filename);
    form.append("stepIdx", String(args.stepIdx));
    form.append("sequence", String(args.sequence));
    form.append("capturedTotal", String(args.capturedTotal));
    form.append("capturedAt", args.capturedAt);

    const res = await fetch(`${env.ENGINE_URL}/api/runs/${args.runId}/artifacts`, {
      method: "POST",
      // NB: no Content-Type — fetch must set the multipart boundary itself. That
      // is why this does not reuse headers(), which pins application/json.
      headers: {
        "x-devpilot-runner-key": env.REGISTRATION_KEY,
        "x-devpilot-runner-tenant": env.TENANT_ID,
      },
      body: form,
      signal: AbortSignal.timeout(ARTIFACT_UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[devpilot-runner] artifact upload run=${args.runId} step=${args.stepIdx} failed: ${res.status} ${(
          await res.text()
        ).slice(0, 200)}`,
      );
      return false;
    }
    // The engine answers 200 with `stored:false` when the run is already at its
    // artifact cap. That is a healthy outcome, not a failure — don't log it as one.
    const body = (await res.json().catch(() => ({}))) as { stored?: boolean };
    return body.stored !== false;
  } catch (err) {
    console.warn(
      `[devpilot-runner] artifact upload run=${args.runId} step=${args.stepIdx} network failure: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

export type RunStepKind = "think" | "tool_call" | "tool_result" | "human" | "system";

export type RunStepInput = {
  kind: RunStepKind;
  payload: Record<string, unknown>;
};

/**
 * "Take the wheel" — append a single activity step to a run's log during an
 * interactive takeover. The runner can't write `run_steps` directly (RLS /
 * service-role only), so it POSTs here and the engine inserts the row at the
 * next free idx. The run page's existing Supabase Realtime subscription lights
 * these up live, so the operator sees both the agent's and their own typed
 * turns reflected in the ticket log.
 *
 * Best-effort: a failed POST is logged and swallowed — losing a mirror line
 * must never interrupt the interactive session.
 */
export async function postRunStep(runId: string, step: RunStepInput): Promise<void> {
  try {
    const res = await fetch(`${env.ENGINE_URL}/api/runs/${runId}/steps`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(step),
    });
    if (!res.ok) {
      console.warn(
        `[devpilot-runner] post run-step failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[devpilot-runner] post run-step network failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Slice C — best-effort system comment from the runner.
 *
 * Used by `workspace.ts` to drop a breadcrumb on the ticket when the
 * auto-stash path fires before the agent's `git reset --hard HEAD` /
 * `git clean -fdx`. The runner POSTs to a dedicated engine endpoint
 * (auth-gated by `x-devpilot-runner-key`) that wraps the existing `addComment`
 * helper. Fire-and-forget — failures are logged but never throw.
 */
export async function postSystemCommentToTicket(input: {
  ticketId: string;
  body: string;
}): Promise<void> {
  try {
    const res = await fetch(`${env.ENGINE_URL}/api/runners/tools/system-comment`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      console.warn(`[devpilot-runner] system-comment failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.warn(
      `[devpilot-runner] system-comment network failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
