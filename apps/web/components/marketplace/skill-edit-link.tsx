// The Edit affordance, as its own component so the "only for rows this tenant
// owns" rule is provable by rendering rather than only by unit-testing the
// predicate behind it.
//
// This is a UI TRUTH, not a security boundary — `/marketplace/[id]/edit` (a
// sibling crew's route) re-checks ownership itself. What this component
// guarantees is that the marketplace never OFFERS a route that cannot succeed:
// a public row is read-only for everything but `service_role`, and a foreign
// row is not ours to touch.

import * as React from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canEditSkill } from "@/lib/marketplace/skill-view";
import type { SkillRow } from "@/lib/skills/types";

export function SkillEditLink({
  skill,
  tenantId,
}: {
  skill: Pick<SkillRow, "id" | "tenant_id">;
  tenantId: string | null | undefined;
}) {
  if (!canEditSkill(skill, tenantId)) return null;
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href={`/marketplace/${skill.id}/edit`}>
        <Pencil className="h-3.5 w-3.5" />
        Edit
      </Link>
    </Button>
  );
}
