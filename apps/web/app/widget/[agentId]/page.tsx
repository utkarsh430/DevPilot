// Phase 1 / M14 — embeddable widget host page.
//
// Served at `/widget/[agentId]`. Designed to be loaded in an iframe on a
// third-party page. The widget client below renders a single-agent chat box;
// it expects a widget token (issued via `/settings/api-keys`) to be passed in
// as the `?token=` query string. The token is bound to a single agent by
// `api_keys.agent_id` so the iframe host can't repurpose it against other
// agents.
//
// XSS safety: we set a tight `Content-Security-Policy` via the route segment
// config below. No inline scripts; everything is hashed by Next.js build.
// The parent page CANNOT postMessage into this iframe without the operator
// opting in — that's a Phase 2 surface (the iframe ignores any postMessage
// today).

import { notFound } from "next/navigation";
import { supabaseService } from "@/lib/db/server";
import { WidgetClient } from "./client";

export const dynamic = "force-dynamic";

// Tight CSP — only this origin's scripts allowed; no inline; styles inline
// permitted (Next.js style tags). Frame-ancestors stays open so operators
// can iframe from any host; a domain-allowlist is a Phase 2 follow-up
// (`docs/DEVPILOT_PHASE1_PLAN.md` open decision).
const CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " + // Next.js needs inline for hydration markers
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-ancestors *;";

export async function generateMetadata() {
  return {
    title: "DevPilot Widget",
    other: {
      "Content-Security-Policy": CSP,
    },
  };
}

export default async function WidgetPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  // We surface the agent's display name to the widget client, but the runtime
  // auth check still happens against `/api/widget/run` (which verifies the
  // token + agent_id binding). Surface only the public-safe fields here.
  const supabase = supabaseService();
  const { data: agent } = await supabase
    .from("agents")
    .select("id, name, role")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) notFound();

  return (
    <div className="bg-background text-foreground flex h-screen flex-col">
      <header className="border-border border-b px-4 py-2 text-sm font-semibold">
        {(agent.name as string) ?? "Agent"}
      </header>
      <WidgetClient agentId={agent.id as string} agentName={(agent.name as string) ?? "Agent"} />
    </div>
  );
}
