"use server";

// Phase 2 / M5e — Server actions backing the Live tab on /changes/[id].
//
// Two actions are exposed:
//
//   • getWorkspaceTreeAction({ pendingPushId }) — Resolves the pending_push
//     row's workspace_path (the absolute path on the runner host) and runs
//     the git-driven tree builder against it. Used on tab-mount and on
//     refresh (manual button + realtime auto-refresh).
//
//   • readWorkspaceFileAction({ pendingPushId, path }) — Reads a single
//     workspace file with the 256 KB cap + binary detection. The path is
//     zod-validated to reject absolute paths and `..` segments BEFORE the
//     library helper's own resolve-based traversal guard runs; defense in
//     depth.
//
// Both actions:
//   • requireUser + requireTenantId, then load the pending_push row through
//     the service-role client and verify `tenant_id`. RLS would catch a
//     cross-tenant access too but the explicit check makes the trust
//     boundary obvious in code review.
//   • Never throw to the client — errors are returned as `{ ok: false,
//     error }` so the client can surface a toast / inline message without
//     a Next.js error boundary unmounting the page.

import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import {
  getWorkspaceTree,
  readWorkspaceFile,
  writeWorkspaceFile,
  type TreeNode,
} from "@/lib/workspace/list";
import { resolveWorkspaceRoot } from "@/lib/workspace-root";
import { checkWorkspaceAvailable } from "@/lib/dev-servers/workspace-availability.server";

// Same rationale as changes/actions.ts's copy: the Live tab browses the
// EXACT directory the row points at, so an unusable `workspace_path`
// can't be re-derived to somewhere useful — fail with a clear message
// instead of a raw ENOENT from the tree/read/write helpers below. Two ways it
// can be unusable (recorded on another host; reaped off disk before the branch
// was pushed) and one shared classifier for both - see
// `lib/dev-servers/workspace-path.ts`.
const WORKSPACE_ROOT = resolveWorkspaceRoot(process.env.WORKSPACE_ROOT);

// Snake-case row shape PostgREST delivers for the trusted lookup. We don't
// need the full set of columns the diff page reads — only enough to verify
// tenant ownership and find the workspace path.
type PendingPushRow = {
  id: string;
  tenant_id: string;
  workspace_path: string;
  /** Read only to tell the operator whether a rebuild is possible. */
  unified_diff: string | null;
};

async function loadPendingPushOrError(
  pendingPushId: string,
  tenantId: string,
): Promise<{ ok: true; row: PendingPushRow } | { ok: false; error: string }> {
  if (!pendingPushId || typeof pendingPushId !== "string") {
    return { ok: false, error: "Invalid pendingPushId" };
  }
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("pending_pushes")
    .select("id, tenant_id, workspace_path, unified_diff")
    .eq("id", pendingPushId)
    .maybeSingle();
  if (error) {
    return { ok: false, error: `pending_push lookup failed: ${error.message}` };
  }
  if (!data) {
    return { ok: false, error: "pending_push not found" };
  }
  const row = data as PendingPushRow;
  if (row.tenant_id !== tenantId) {
    // Surface as "not found" rather than "forbidden" so we don't leak the
    // existence of a row owned by a different tenant.
    return { ok: false, error: "pending_push not found" };
  }
  if (!row.workspace_path || typeof row.workspace_path !== "string") {
    return { ok: false, error: "pending_push has no workspace_path" };
  }
  const availability = await checkWorkspaceAvailable({
    storedPath: row.workspace_path,
    workspaceRoot: WORKSPACE_ROOT,
    hasSavedDiff: typeof row.unified_diff === "string" && row.unified_diff.trim().length > 0,
  });
  if (!availability.available) {
    return { ok: false, error: availability.message };
  }
  return { ok: true, row };
}

export type GetWorkspaceTreeResult =
  | {
      ok: true;
      root: TreeNode;
      totalFiles: number;
      changedFiles: number;
    }
  | { ok: false; error: string };

export async function getWorkspaceTreeAction(input: {
  pendingPushId: string;
}): Promise<GetWorkspaceTreeResult> {
  try {
    await requireUser();
    const tenantId = await requireTenantId();
    const loaded = await loadPendingPushOrError(input.pendingPushId, tenantId);
    if (!loaded.ok) return loaded;
    const { root, totalFiles, changedFiles } = await getWorkspaceTree(loaded.row.workspace_path);
    return { ok: true, root, totalFiles, changedFiles };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Path validation:
//   • non-empty, max 2 KB (we'd never legitimately preview a longer path),
//   • no leading "/" (would skip the workspace root in path.resolve),
//   • no ".." segment (would let a relative path walk above the root).
//
// The library helper's `path.resolve` + prefix check is the actual
// enforcement; this refine is a fast-fail so the trusted helper never
// sees a clearly malformed path.
const ReadFileInput = z.object({
  pendingPushId: z.string().uuid(),
  path: z
    .string()
    .min(1)
    .max(2048)
    .refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."), "Invalid path"),
});

export type ReadWorkspaceFileResult =
  | {
      ok: true;
      content: string | null;
      bytes: number;
      binary: boolean;
      truncated: boolean;
    }
  | { ok: false; error: string };

export async function readWorkspaceFileAction(input: unknown): Promise<ReadWorkspaceFileResult> {
  try {
    const parsed = ReadFileInput.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }
    await requireUser();
    const tenantId = await requireTenantId();
    const loaded = await loadPendingPushOrError(parsed.data.pendingPushId, tenantId);
    if (!loaded.ok) return loaded;
    const { content, bytes, binary, truncated } = await readWorkspaceFile(
      loaded.row.workspace_path,
      parsed.data.path,
      { maxBytes: 256 * 1024 },
    );
    return { ok: true, content, bytes, binary, truncated };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ===========================================================================
// writeWorkspaceFileAction — operator inline-edits a file before push.
//
// Mirrors the read-side action but writes content to disk on the runner
// host. Same path-traversal guard, same tenant gate.  We do NOT commit
// the change — the operator is expected to either re-trigger the agent
// (which will commit on the next iteration) or use the existing push
// action (which already does an implicit `git add -A`).
//
// Honesty note: the Files tab renders from `pending_pushes.unified_diff`,
// a snapshot captured by the tracker on the last agent commit. An inline
// edit changes the working tree but NOT the cached diff blob — the UI
// will look stale until the tracker reruns. The Live tab reads the
// workspace directly so its preview reflects writes immediately.

const WriteFileInput = z.object({
  pendingPushId: z.string().uuid(),
  path: z
    .string()
    .min(1)
    .max(2048)
    .refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."), "Invalid path"),
  content: z.string().max(1024 * 1024, "Content exceeds 1MB cap"),
});

export type WriteWorkspaceFileResult = { ok: true; bytes: number } | { ok: false; error: string };

export async function writeWorkspaceFileAction(input: unknown): Promise<WriteWorkspaceFileResult> {
  try {
    const parsed = WriteFileInput.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }
    await requireUser();
    const tenantId = await requireTenantId();
    const loaded = await loadPendingPushOrError(parsed.data.pendingPushId, tenantId);
    if (!loaded.ok) return loaded;
    const { bytes } = await writeWorkspaceFile(
      loaded.row.workspace_path,
      parsed.data.path,
      parsed.data.content,
    );
    return { ok: true, bytes };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
