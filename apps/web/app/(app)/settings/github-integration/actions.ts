"use server";

// Phase 2 / M5a — GitHub integration settings server actions.
//
// disconnectGithubAction:
//   Drop the user's row in `github_oauth_tokens` via A2's `deleteGithubToken`
//   helper. This only removes DevPilot's copy of the token — it does NOT revoke the
//   OAuth app on GitHub's side. The UI surfaces a reminder pointing at
//   github.com/settings/applications for the full clean-up.

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { deleteGithubToken } from "@/lib/github/oauth";

export type DisconnectGithubResult = { ok: true } | { ok: false; error: string };

export async function disconnectGithubAction(): Promise<DisconnectGithubResult> {
  const user = await requireUser();
  try {
    await deleteGithubToken(user.id);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "delete failed",
    };
  }
  revalidatePath("/settings/github-integration");
  revalidatePath("/projects");
  revalidatePath("/projects/new");
  return { ok: true };
}
