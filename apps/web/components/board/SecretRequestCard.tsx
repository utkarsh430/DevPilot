"use client";

// Slice A — masked-input form for `devpilot_request_secret` comments.
//
// Rendered inline inside the TicketDrawer thread tab when a comment's
// metadata.kind === 'secret_request'.
//
// The FORM itself is `SecretValuesForm` — the one masked-input form in the
// codebase, shared with the Vercel env push so there is a single way DevPilot
// collects a secret value from a human. What this card adds on top is the part
// that is specific to a PARKED TICKET: after the values land it posts a human
// comment, and that comment is what transitions `input_required → in_progress`
// and fires the dispatch (Slice B's emit-dispatch plumbing). The next run sees
// the new values in <workspace>/.env.local and in process.env.
//
// Note the resume comment reports the keys that ACTUALLY saved, not the keys
// that were asked for. A partial save is possible (one action call per key) and
// the previous version both claimed otherwise and reported the full list, which
// would tell the resumed agent it had values it did not have.

import * as React from "react";
import { KeyRound } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { SecretValuesForm } from "@/components/secrets/SecretValuesForm";
import { postCommentAction } from "@/app/(app)/board/actions";

type Props = {
  ticketId: string;
  /** From the comment's metadata. Required for setProjectSecretAction. */
  projectId: string | null;
  /** Ordered list of env var names the agent asked for. */
  keys: string[];
  /** The agent's rationale body — rendered above the form. */
  rationale: string;
};

export function SecretRequestCard({ ticketId, projectId, keys, rationale }: Props) {
  async function onSaved(savedKeys: string[]) {
    const post = await postCommentAction({
      ticketId,
      body: `Provided ${savedKeys.length} secret${savedKeys.length === 1 ? "" : "s"}: ${savedKeys.join(", ")}`,
    });
    if (!post.ok) {
      toast.error("Saved but couldn't resume ticket", { description: post.error });
    }
  }

  return (
    <div className="border-warning/40 bg-warning/5 rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2">
        <KeyRound className="text-warning h-3.5 w-3.5" />
        <span className="text-warning text-xs font-medium">
          Agent needs {keys.length} env var{keys.length === 1 ? "" : "s"}
        </span>
      </div>
      {rationale ? <p className="text-muted-foreground mb-3 text-xs">{rationale}</p> : null}
      {projectId == null ? (
        <p className="text-destructive text-xs italic">
          This ticket isn&apos;t attached to a project — secrets can&apos;t be stored. Attach the
          ticket to a project first.
        </p>
      ) : (
        <SecretValuesForm
          projectId={projectId}
          keys={keys}
          submitLabel="Provide secrets"
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
