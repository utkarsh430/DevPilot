// Author a new skill — `/marketplace/new`.
//
// The route the marketplace catalogue links to for "publish your own". This
// change owns `/marketplace/new` and `/marketplace/[id]/edit` and nothing else
// under `/marketplace`; the catalogue page, its client and the preview
// component belong to a sibling change and are untouched here.
//
// A skill created here is ALWAYS owned by the caller's workspace
// (`skills.tenant_id = <session tenant>`). There is no control on this page,
// and no argument on the action behind it, that can write a PUBLIC
// (`tenant_id IS NULL`) marketplace row — publishing to the public catalogue
// remains the env-gated, service-role `publishSkillAction`.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { SkillForm } from "../skill-form";

export const dynamic = "force-dynamic";

export default async function NewSkillPage() {
  // Gate before rendering a form whose action would refuse anyway — a signed-out
  // visitor should not be typing a skill body into a box that cannot save it.
  await requireUser();
  await requireTenantId();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Button asChild size="sm" variant="ghost" className="-ml-2 mb-4">
        <Link href="/marketplace">
          <ArrowLeft className="h-3.5 w-3.5" />
          Marketplace
        </Link>
      </Button>

      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight">New skill</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Guidance of your own, added to the prompt of the agents you choose.
        </p>
      </div>

      <SkillForm />
    </div>
  );
}
