// Edit one of this workspace's own skills — `/marketplace/[id]/edit`.
//
// The load is scoped on `id` AND `tenant_id`, so three cases collapse to one
// 404 and none of them renders an editable form:
//   • an id belonging to another workspace;
//   • a PUBLIC marketplace id (its `tenant_id` is null, which matches no
//     tenant) — the catalogue's own rows are read-only here by construction,
//     not by a check that could be forgotten;
//   • an id that does not exist.
//
// That is the same refusal the action performs independently, so the page
// showing a form is never what authorises the save.

import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, GitBranch } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { Button } from "@/components/ui/button";
import { loadOwnedSkill, loadUpstreamSkill } from "@/lib/skills/authoring-store";
import {
  classifySkillProvenance,
  describeSkillProvenance,
} from "@/lib/marketplace/skill-provenance";
import { SkillForm } from "../../skill-form";

export const dynamic = "force-dynamic";

export default async function EditSkillPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await requireTenantId();
  const { id } = await params;

  const skill = await loadOwnedSkill(supabaseService(), { id, tenantId });
  if (!skill) notFound();

  const summary = typeof skill.manifest?.summary === "string" ? skill.manifest.summary : "";

  // An installed clone has a public source; an authored skill does not. The read
  // is `tenant_id IS NULL`-scoped, so a null here means "no catalogue entry",
  // never "someone else's row" — and provenance degrades to
  // `upstream_unavailable` rather than guessing.
  const source = skill.installed_from_skill_id
    ? await loadUpstreamSkill(supabaseService(), { id: skill.installed_from_skill_id })
    : null;
  const provenance = classifySkillProvenance(skill, source);
  const provenanceCopy = describeSkillProvenance(provenance);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Button asChild size="sm" variant="ghost" className="-ml-2 mb-4">
        <Link href="/marketplace">
          <ArrowLeft className="h-3.5 w-3.5" />
          Marketplace
        </Link>
      </Button>

      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Edit skill</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Changes apply to the next run of every agent this skill matches. Runs already finished
          keep the guidance they were given.
        </p>
      </div>

      {/*
        For a clone, the two facts an operator needs BEFORE typing — and both
        were previously unstated anywhere in the product:

          • this is his own copy, so editing it changes nothing for anyone else
            and cannot reach the public catalogue;
          • the catalogue shipping a new version will not overwrite what he
            writes here.

        The second is the one worth saying out loud. It is structurally true —
        nothing in DevPilot writes a tenant skill row from upstream except the
        explicit control on the marketplace card — but a guarantee nobody has
        been told about does not stop anyone hesitating over the edit.
      */}
      {provenance.kind !== "authored" && (
        <div
          role="note"
          className="border-border bg-muted/30 mb-6 flex items-start gap-3 rounded-lg border p-3 text-xs"
        >
          <GitBranch className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="text-foreground/90 min-w-0">
            <strong className="font-semibold">This is your workspace&apos;s own copy.</strong>{" "}
            Installing cloned the catalogue text into a row only this workspace can see, so editing
            it changes nothing for anyone else and never touches the public catalogue entry. A newer
            catalogue version will not overwrite your changes — the marketplace card flags one and
            lets you take it deliberately.
            <p className="text-muted-foreground mt-1.5">{provenanceCopy.detail}</p>
          </div>
        </div>
      )}

      <SkillForm
        initial={{
          id: skill.id,
          name: skill.name,
          version: skill.version,
          summary,
          body: skill.body,
          targets: Array.isArray(skill.targets) ? skill.targets : [],
          triggers: Array.isArray(skill.triggers) ? skill.triggers : [],
        }}
      />
    </div>
  );
}
