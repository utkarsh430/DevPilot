"use client";

// Project settings card for changing the default team tier.
//
// The tier lives on `projects.team_tier` and drives roster + ticket-count
// caps on every planning session that inherits from the project. The Save
// button is gated on a real change so the operator can't accidentally
// re-stamp the same value.

import * as React from "react";
import { Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { TierPicker } from "@/components/team-tiers/TierPicker";
import type { TeamTier } from "@/lib/team-tiers/tiers";
import { updateProjectTeamTierAction } from "../actions";

export function TeamTierCard({
  projectId,
  initialTier,
}: {
  projectId: string;
  initialTier: TeamTier;
}) {
  const [tier, setTier] = React.useState<TeamTier>(initialTier);
  const [saved, setSaved] = React.useState<TeamTier>(initialTier);
  const [busy, setBusy] = React.useState(false);
  const dirty = tier !== saved;

  async function onSave() {
    setBusy(true);
    const res = await updateProjectTeamTierAction({
      projectId,
      teamTier: tier,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error("Couldn't update team tier", { description: res.error });
      return;
    }
    setSaved(tier);
    toast.success("Team tier updated", {
      description: "New plans on this project will use the new tier.",
    });
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="text-muted-foreground h-4 w-4" />
          Team tier
        </CardTitle>
        <CardDescription className="text-xs">
          Default for every plan session on this project. Each session can still override it at
          kickoff.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <TierPicker value={tier} onChange={(t) => setTier(t ?? saved)} disabled={busy} />
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={onSave}
            disabled={!dirty || busy}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
