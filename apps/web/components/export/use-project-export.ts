"use client";

// Drive the async project-export job from the client: enqueue → poll → download.
//
// The per-TICKET export needs none of this — it is a plain `<a download>` at a
// route that streams the PDF. A PROJECT export can take a minute (it batches up
// to MAX_FULL_TICKETS tickets' runs, narration and embedded images), which is
// well past a serverless request's patience, so it renders in a durable Inngest
// function and lands in a private bucket. That means the client has three steps
// instead of one, and this hook owns all three so both trigger sites (the board's
// "More" menu and the project header menu) behave identically.
//
// Polling rather than realtime: an export is a one-shot the operator is actively
// waiting on, it settles in seconds-to-a-minute, and a dedicated channel +
// subscription for a single row would be more machinery than a 2s poll that
// stops on its own. `use-live-dev-server` / `use-system-health` take the same
// view (AGENTS.md exempts them from the realtime-reconnect rule for this reason).

import * as React from "react";
import { toast } from "@/components/ui/sonner";
import type { ExportStatusResponse } from "@/app/api/export/[exportId]/route";
import type { CreateProjectExportResponse } from "@/app/api/export/projects/[id]/route";

const POLL_INTERVAL_MS = 2_000;
/** Give up after ~3 minutes. The job itself is durable and may still land; this
 *  only bounds how long the BUTTON claims to be working. */
const POLL_TIMEOUT_MS = 180_000;

export type ProjectExportState = "idle" | "working";

export function useProjectExport(projectId: string | null) {
  const [state, setState] = React.useState<ProjectExportState>("idle");
  // Survives unmount (the dropdown closes the moment the item is chosen), so a
  // late poll can't setState on a dead component.
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = React.useCallback(async () => {
    if (!projectId || state === "working") return;
    setState("working");
    const toastId = toast.loading("Building the project audit PDF…", {
      description: "Aggregating tickets, runs and evidence. This can take a minute.",
    });

    try {
      const res = await fetch(`/api/export/projects/${projectId}`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Could not start the export"));
      const { exportId } = (await res.json()) as CreateProjectExportResponse;

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        await sleep(POLL_INTERVAL_MS);
        if (Date.now() > deadline) {
          throw new Error(
            "The export is taking longer than expected. It may still finish — check back shortly.",
          );
        }
        const poll = await fetch(`/api/export/${exportId}`, { cache: "no-store" });
        if (!poll.ok) throw new Error(await readError(poll, "Lost track of the export"));
        const job = (await poll.json()) as ExportStatusResponse;
        if (job.status === "failed") {
          // The stored reason is engine-authored (a DB/storage/aggregation
          // message), never agent text, so it is safe to show verbatim.
          throw new Error(job.error ?? "The export failed.");
        }
        if (job.status === "ready") {
          toast.success("Project audit PDF ready", { id: toastId, description: "Downloading…" });
          // The download route mints a short-TTL signed URL and 302s to it.
          // Navigating (rather than fetch+blob) keeps the browser's own download
          // machinery in charge and never buffers the PDF in JS memory.
          window.location.href = `/api/export/${exportId}/download`;
          return;
        }
        // still pending — keep waiting
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Project export failed", { id: toastId, description: message });
    } finally {
      if (alive.current) setState("idle");
    }
  }, [projectId, state]);

  return { state, start, busy: state === "working" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ? `${fallback}: ${body.error}` : `${fallback} (HTTP ${res.status})`;
  } catch {
    return `${fallback} (HTTP ${res.status})`;
  }
}
