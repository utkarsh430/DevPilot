// M5 — JD-to-role synthesizer.
//
// Paste a job description, run synthesis (Sonnet), edit the draft, save as a
// custom role under the current tenant. The saved row is an `agents` insert
// whose `config.role_config` follows the shape `lib/roles/load.ts` reads at
// dispatch time. Custom-role tickets are routed via `tickets.requested_role`
// matching the slug.
//
// This file is the server shell: it does the auth gate and renders the
// client form. All interactivity lives in `synth-form.tsx`.

import { Wand2 } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { SynthForm } from "./synth-form";

export const dynamic = "force-dynamic";

export default async function NewAgentPage() {
  await requireUser();
  await requireTenantId();

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wider">
          <Wand2 className="h-3.5 w-3.5" />
          New role · JD synthesizer
        </div>
        <h1 className="font-display mt-1 text-3xl font-bold tracking-tight">
          Turn a job description into a role
        </h1>
        <p className="text-muted-foreground mt-3 max-w-2xl text-sm">
          Paste a JD, generate a draft system prompt and runtime config, edit anything, and save.
          The new role becomes dispatchable the moment a ticket sets{" "}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">requested_role</code> to
          your slug.
        </p>
      </header>

      <SynthForm />
    </div>
  );
}
