"use server";

// Slice C — server actions that resolve an absolute workspace path
// (server-side only) and hand back a `vscode://file/<abs-path>` URL the
// browser invokes via window.location.href on click.
//
// We never put the workspace path in the page's HTML/JSON. The action is
// called on the click handler — the URL only exists for the moment of the
// navigation. This keeps the operator's $HOME path off all rendered
// surfaces, including the React tree's serialized server-component output.
//
// Three discriminated inputs cover the three places we render the button:
//   • { kind: "pending_push" } — Live tab on /changes/[pendingPushId]
//   • { kind: "dev_server" } — RunPanel
//   • { kind: "ticket" } — TicketDrawer header
//
// For the ticket variant we resolve the workspace via the most-recent
// run.payload.workspacePath (set by the runner via wave 2's M0 plumbing).
//
// File-scoped variants (filePath supplied) append `/<filePath>` AND
// `?line=1` so VS Code opens the file with the cursor at line 1.

import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { hostWorkspacePath } from "@/lib/dev-servers/workspace-path";
import { resolveWorkspaceRoot } from "@/lib/workspace-root";
import path from "node:path";

const WORKSPACE_ROOT = resolveWorkspaceRoot(process.env.WORKSPACE_ROOT);

type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

const PendingPushInput = z.object({
  kind: z.literal("pending_push"),
  pendingPushId: z.string().uuid(),
  filePath: z.string().optional(),
});

const DevServerInput = z.object({
  kind: z.literal("dev_server"),
  sessionId: z.string().uuid(),
  filePath: z.string().optional(),
});

const TicketInput = z.object({
  kind: z.literal("ticket"),
  ticketId: z.string().uuid(),
  filePath: z.string().optional(),
});

const OpenInput = z.union([PendingPushInput, DevServerInput, TicketInput]);

function buildVscodeUrl(workspacePath: string, filePath?: string): string {
  // Defensive: reject anything that would let a caller escape the workspace
  // root. The filePath comes from the client, so we never let `..` segments
  // through. The workspace path itself is server-resolved and trusted.
  if (filePath) {
    const safe = path.posix.normalize(filePath.replace(/\\/g, "/"));
    if (safe.startsWith("..") || path.isAbsolute(safe)) {
      // Fall back to the folder URL — never throw, never leak the absolute
      // path through an error to the client.
      return `vscode://file${workspacePath}`;
    }
    return `vscode://file${workspacePath}/${safe}?line=1`;
  }
  return `vscode://file${workspacePath}`;
}

export async function getVscodeOpenUrlAction(
  input: z.infer<typeof OpenInput>,
): Promise<ActionResult<{ url: string }>> {
  const parsed = OpenInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const supabase = await supabaseServer();

  let workspacePath: string | null = null;
  if (parsed.data.kind === "pending_push") {
    const { data, error } = await supabase
      .from("pending_pushes")
      .select("tenant_id, project_id, ticket_id, workspace_path")
      .eq("id", parsed.data.pendingPushId)
      .maybeSingle();
    if (error || !data) return { ok: false, error: "pending_push not found" };
    const row = data as {
      tenant_id: string;
      project_id: string;
      ticket_id: string | null;
      workspace_path: string | null;
    };
    if (row.tenant_id !== tenantId) return { ok: false, error: "forbidden" };
    workspacePath = row.workspace_path
      ? hostWorkspacePath(row.workspace_path, row.ticket_id, row.project_id, WORKSPACE_ROOT)
      : null;
  } else if (parsed.data.kind === "dev_server") {
    const { data, error } = await supabase
      .from("dev_server_sessions")
      .select("tenant_id, project_id, ticket_id, workspace_path")
      .eq("id", parsed.data.sessionId)
      .maybeSingle();
    if (error || !data) return { ok: false, error: "dev_server session not found" };
    const row = data as {
      tenant_id: string;
      project_id: string;
      ticket_id: string | null;
      workspace_path: string | null;
    };
    if (row.tenant_id !== tenantId) return { ok: false, error: "forbidden" };
    workspacePath = row.workspace_path
      ? hostWorkspacePath(row.workspace_path, row.ticket_id, row.project_id, WORKSPACE_ROOT)
      : null;
  } else {
    // Ticket scope. The workspace path lives in three places (in order
    // of preference because each is progressively older / less likely to
    // be fresh):
    //   1. `pending_pushes.workspace_path` — written by `pendingPushTracker`
    //      after every workspace-mode run. Filtered to the ticket via
    //      pending_pushes.ticket_id.
    //   2. `dev_server_sessions.workspace_path` — written by the dev-server
    //      start action when the operator hit "Run on localhost" for this
    //      ticket. Filtered via dev_server_sessions.ticket_id.
    //   3. `run_steps.payload->>workspace_path` — stamped by `runAgent`'s
    //      persist step for every claude iteration that had a cwd. Joined
    //      via runs.ticket_id. This is the deepest fallback and works
    //      even for tickets that never had a pending push or dev server.
    //
    // We DO NOT look at runs.payload.workspacePath — that field doesn't
    // exist; the value is on run_steps.payload.workspace_path (snake_case)
    // not on the runs row itself. An earlier draft of this action had
    // the wrong lookup and produced a confusing "no runs found" toast for
    // tickets that had runs but no pending push.
    const { data: ticketRow } = await supabase
      .from("tickets")
      .select("project_id")
      .eq("id", parsed.data.ticketId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const projectId = (ticketRow as { project_id: string } | null)?.project_id;
    if (!projectId) return { ok: false, error: "ticket not found" };

    let rawWorkspacePath: string | null = null;
    const { data: pushes } = await supabase
      .from("pending_pushes")
      .select("workspace_path, tenant_id, updated_at")
      .eq("ticket_id", parsed.data.ticketId)
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (pushes && pushes.length > 0) {
      rawWorkspacePath = (pushes[0] as { workspace_path: string | null }).workspace_path;
    }
    if (!rawWorkspacePath) {
      const { data: sessions } = await supabase
        .from("dev_server_sessions")
        .select("workspace_path, tenant_id, started_at")
        .eq("ticket_id", parsed.data.ticketId)
        .eq("tenant_id", tenantId)
        .order("started_at", { ascending: false })
        .limit(1);
      if (sessions && sessions.length > 0) {
        rawWorkspacePath = (sessions[0] as { workspace_path: string | null }).workspace_path;
      }
    }
    if (!rawWorkspacePath) {
      // Walk the ticket's runs newest-first via a join and pull the first
      // run_steps row with a non-null workspace_path. We can't run a
      // single SQL join via the typed client, so we look up run ids first,
      // then probe run_steps.
      const { data: runs } = await supabase
        .from("runs")
        .select("id")
        .eq("ticket_id", parsed.data.ticketId)
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(20);
      const runIds = (runs ?? []).map((r) => String(r.id));
      if (runIds.length > 0) {
        const { data: steps } = await supabase
          .from("run_steps")
          .select("payload, created_at")
          .in("run_id", runIds)
          .order("created_at", { ascending: false })
          .limit(50);
        for (const s of steps ?? []) {
          const p = (s as { payload?: { workspace_path?: string } }).payload?.workspace_path;
          if (typeof p === "string" && p.length > 0) {
            rawWorkspacePath = p;
            break;
          }
        }
      }
    }
    if (!rawWorkspacePath) {
      return {
        ok: false,
        error: "no workspace recorded for this ticket yet",
      };
    }
    workspacePath = hostWorkspacePath(
      rawWorkspacePath,
      parsed.data.ticketId,
      projectId,
      WORKSPACE_ROOT,
    );
  }

  if (!workspacePath) {
    return { ok: false, error: "workspace path missing on the row" };
  }
  return { ok: true, value: { url: buildVscodeUrl(workspacePath, parsed.data.filePath) } };
}
