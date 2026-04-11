// Phase 2 / M5c — `/changes/[pendingPushId]` detail page.
//
// Server shell: auth gate, load the pending_push row + the project + the
// ticket, slice the unified diff into per-file blobs (so the diff viewer
// can render each file independently), then hand off to the client.
//
// The unified_diff blob is parsed server-side to keep the client payload
// lean — the client only needs `path → { oldValue, newValue }` for the
// react-diff-viewer-continued props. Large files (> 1k lines after split)
// are surfaced as raw text with a "too big to render diff" hint.

import { notFound } from "next/navigation";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { loadProjectById, type ProjectRecord } from "@/lib/projects/load";
import {
  DiffReviewClient,
  type DiffReviewFile,
  type DiffReviewPendingPush,
  type DiffReviewProject,
  type DiffReviewTicket,
} from "./diff-review-client";

export const dynamic = "force-dynamic";

type PendingPushDbRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  ticket_id: string | null;
  run_id: string | null;
  workspace_path: string;
  branch: string;
  unpushed_count: number | null;
  files_changed: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }> | null;
  unified_diff: string | null;
  head_sha: string | null;
  pushed_at: string | null;
  pushed_pr_url: string | null;
  created_at: string;
  updated_at: string;
  // Slice IB-B — conflict columns. Null on pushes that pre-date the
  // pre-push rebase block; non-null after the first push attempt.
  conflict_state: "clean" | "rebased" | "conflict" | "resolved" | null;
  conflict_detail: {
    files: string[];
    stderr: string;
    base_sha: string | null;
    branch_sha: string | null;
  } | null;
  rebased_onto_sha: string | null;
  merger_ticket_id: string | null;
};

type TicketDbRow = {
  id: string;
  title: string | null;
  description: string | null;
  status: string | null;
};

export default async function DiffReviewPage({
  params,
}: {
  params: Promise<{ pendingPushId: string }>;
}) {
  await requireUser();
  const tenantId = await requireTenantId();
  const { pendingPushId } = await params;

  const supabase = supabaseService();
  const { data: pendingRaw } = await supabase
    .from("pending_pushes")
    .select(
      "id, tenant_id, project_id, ticket_id, run_id, workspace_path, branch, unpushed_count, files_changed, unified_diff, head_sha, pushed_at, pushed_pr_url, created_at, updated_at, conflict_state, conflict_detail, rebased_onto_sha, merger_ticket_id",
    )
    .eq("id", pendingPushId)
    .maybeSingle();
  const pending = pendingRaw as PendingPushDbRow | null;
  if (!pending) notFound();
  if (pending.tenant_id !== tenantId) notFound();

  const project = await loadProjectById(pending.project_id);
  if (!project) notFound();
  if (project.tenantId !== tenantId) notFound();

  let ticket: TicketDbRow | null = null;
  if (pending.ticket_id) {
    const { data: ticketData } = await supabase
      .from("tickets")
      .select("id, title, description, status")
      .eq("id", pending.ticket_id)
      .maybeSingle();
    ticket = (ticketData as TicketDbRow | null) ?? null;
  }

  const files = sliceUnifiedDiff(
    pending.unified_diff,
    Array.isArray(pending.files_changed) ? pending.files_changed : [],
  );

  return (
    <DiffReviewClient
      tenantId={tenantId}
      pendingPush={mapPending(pending)}
      project={mapProject(project)}
      ticket={ticket ? mapTicket(ticket) : null}
      files={files}
    />
  );
}

function mapPending(row: PendingPushDbRow): DiffReviewPendingPush {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    runId: row.run_id,
    branch: row.branch,
    workspacePath: row.workspace_path,
    unpushedCount: row.unpushed_count ?? 0,
    filesChanged: Array.isArray(row.files_changed) ? row.files_changed : [],
    headSha: row.head_sha,
    pushedAt: row.pushed_at,
    pushedPrUrl: row.pushed_pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conflictState: row.conflict_state,
    conflictDetail: row.conflict_detail,
    rebasedOntoSha: row.rebased_onto_sha,
    mergerTicketId: row.merger_ticket_id,
  };
}

function mapProject(p: ProjectRecord): DiffReviewProject {
  return {
    id: p.id,
    name: p.name,
    repoUrl: p.repoUrl,
    githubOwner: p.githubOwner,
    githubRepo: p.githubRepo,
    defaultBranch: p.defaultBranch,
    integrationBranch: p.integrationBranch,
  };
}

function mapTicket(t: TicketDbRow): DiffReviewTicket {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
  };
}

// ─── Unified diff slicer ──────────────────────────────────────────────────
//
// react-diff-viewer-continued takes `oldValue` + `newValue` per render. The
// tracker (A5) hands us a unified diff blob that's a concatenation of
// `diff --git a/foo b/foo` chunks. We split on those headers and reconstruct
// the pre/post text per file from the `-` / `+` line markers.
//
// Edge cases:
//   • Binary diffs ("Binary files ... differ") → mark as binary, no text.
//   • Files larger than LINE_CAP after reconstruction → mark as too-big.
//   • Deleted files → newValue is empty.
//   • New files → oldValue is empty.
//
// This is a pragmatic parser, not a full unified-diff implementation. For
// the seed scaffolder commits + typical engineer diffs it's accurate. The
// diff viewer itself handles the rest of the rendering.

const LINE_CAP = 4_000;

function sliceUnifiedDiff(
  unifiedDiff: string | null,
  filesChanged: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>,
): DiffReviewFile[] {
  // If there's no diff text at all, still surface the file list with empty
  // viewer state so the operator can at least see WHAT changed even when
  // the tracker elided the diff.
  if (!unifiedDiff) {
    return filesChanged.map((f) => ({
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      kind: "missing" as const,
      oldValue: "",
      newValue: "",
    }));
  }

  const byPath = new Map<string, { old: string[]; nxt: string[]; binary: boolean }>();

  // Split into per-file sections. A unified diff section starts with
  // `diff --git a/<old> b/<new>`. We split, then process each section.
  const sections = unifiedDiff.split(/^diff --git /m).filter(Boolean);
  for (const section of sections) {
    // First line of `section` is `a/<old> b/<new>`. Pull both paths; prefer
    // `b/...` as the canonical post-rename path.
    const firstLineEnd = section.indexOf("\n");
    const header = section.slice(0, firstLineEnd === -1 ? section.length : firstLineEnd);
    const matched = /^a\/(.+?) b\/(.+)$/.exec(header.trim());
    const pathName = matched?.[2] ?? matched?.[1] ?? "<unknown>";

    if (/^Binary files /m.test(section)) {
      byPath.set(pathName, { old: [], nxt: [], binary: true });
      continue;
    }

    const lines = section.slice(firstLineEnd + 1).split("\n");
    const old: string[] = [];
    const nxt: string[] = [];

    let inHunk = false;
    for (const line of lines) {
      // Skip the file header lines (`index`, `---`, `+++`, `new file mode`,
      // etc.) until we hit the first `@@` hunk header.
      if (!inHunk) {
        if (line.startsWith("@@")) inHunk = true;
        continue;
      }
      if (line.startsWith("@@")) continue;
      if (line.startsWith("\\")) continue; // e.g. `\ No newline at end of file`
      if (line.startsWith("+")) {
        nxt.push(line.slice(1));
      } else if (line.startsWith("-")) {
        old.push(line.slice(1));
      } else {
        // context line — appears in both sides
        const ctx = line.startsWith(" ") ? line.slice(1) : line;
        old.push(ctx);
        nxt.push(ctx);
      }
    }

    const prev = byPath.get(pathName);
    if (prev) {
      prev.old.push(...old);
      prev.nxt.push(...nxt);
    } else {
      byPath.set(pathName, { old, nxt, binary: false });
    }
  }

  // Build the ordered list, preferring the order from files_changed (which
  // matches the run inspector / push tracker order) but appending anything
  // we discovered in the diff but not in files_changed.
  const seen = new Set<string>();
  const out: DiffReviewFile[] = [];

  for (const f of filesChanged) {
    seen.add(f.path);
    const slice = byPath.get(f.path);
    out.push(buildFile(f, slice));
  }
  for (const [pathName, slice] of byPath) {
    if (seen.has(pathName)) continue;
    out.push(buildFile({ path: pathName, status: "M", additions: 0, deletions: 0 }, slice));
  }
  return out;
}

function buildFile(
  meta: { path: string; status: string; additions: number; deletions: number },
  slice: { old: string[]; nxt: string[]; binary: boolean } | undefined,
): DiffReviewFile {
  if (!slice) {
    return {
      path: meta.path,
      status: meta.status,
      additions: meta.additions,
      deletions: meta.deletions,
      kind: "missing",
      oldValue: "",
      newValue: "",
    };
  }
  if (slice.binary) {
    return {
      path: meta.path,
      status: meta.status,
      additions: meta.additions,
      deletions: meta.deletions,
      kind: "binary",
      oldValue: "",
      newValue: "",
    };
  }
  if (slice.old.length > LINE_CAP || slice.nxt.length > LINE_CAP) {
    return {
      path: meta.path,
      status: meta.status,
      additions: meta.additions,
      deletions: meta.deletions,
      kind: "too_big",
      oldValue: "",
      newValue: "",
    };
  }
  return {
    path: meta.path,
    status: meta.status,
    additions: meta.additions,
    deletions: meta.deletions,
    kind: "text",
    oldValue: slice.old.join("\n"),
    newValue: slice.nxt.join("\n"),
  };
}
