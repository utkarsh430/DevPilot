"use client";

// The prompt view. The SHIPPED prompt stays read-only by construction — there
// is no control here that edits it, because the operator never edits it. What
// he gets instead is `OverlayEditor` below: his own instructions, appended
// beneath the shipped prompt inside a fence that subordinates them to it.
//
// The composed pane INCLUDES the overlay when there is one, deliberately: it is
// deterministic (the same on every ticket, exactly like the two layers above
// it), so showing the prompt without the operator's own standing instructions
// would be the confident-lie class this page exists to avoid. Skills and lessons
// stay out of it and stay named-not-spliced, because those ARE per-ticket.

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import type { AgentPromptInspection } from "@/lib/roles/prompt-inspection";
import {
  LESSON_DISCLOSURE,
  SKILL_DISCLOSURE,
  describeLessonScope,
} from "@/lib/roles/prompt-inspection";
import { OverlayEditor } from "./overlay-editor";

function CopyPromptButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast.error("Couldn't copy", {
        description: err instanceof Error ? err.message : "clipboard blocked",
      });
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={onCopy}>
      {copied ? <Check className="text-success h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy prompt"}
    </Button>
  );
}

export function PromptView({ inspection }: { inspection: AgentPromptInspection }) {
  const { composed, layers, eligibleSkills, eligibleLessons } = inspection;

  return (
    <div className="flex flex-col gap-6">
      {/* ── The layer explainer ─────────────────────────────────────────── */}
      <section className="bg-muted/30 rounded-lg border p-4">
        <h2 className="text-sm font-semibold tracking-tight">
          How this agent&apos;s instructions are put together
        </h2>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          DevPilot assembles them fresh on every dispatch — nothing is stored as one blob, so a
          change to any layer reaches the next run. The{" "}
          <strong className="font-medium">system prompt</strong> below is the agent&apos;s standing
          brief and is the same on every ticket. Two further things are chosen per ticket and shown
          further down: installed <strong className="font-medium">skills</strong>, appended to that
          prompt, and approved <strong className="font-medium">lessons</strong>, added to the
          individual ticket&apos;s brief.
        </p>
        <ol className="mt-3 flex flex-col gap-3">
          {layers.map((layer, i) => (
            <li key={layer.kind} className="flex gap-3">
              <span className="bg-background text-muted-foreground mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px] font-medium tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-xs font-medium">{layer.title}</span>
                  <span className="text-muted-foreground text-[10px] tabular-nums">
                    {layer.chars.toLocaleString()} chars
                  </span>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  {layer.explainer}
                </p>
                <p className="text-muted-foreground/80 mt-0.5 text-[11px] leading-relaxed">
                  {layer.origin}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── The composed prompt ─────────────────────────────────────────── */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">System prompt</h2>
            <p className="text-muted-foreground text-xs">
              {composed.length.toLocaleString()} characters — the agent&apos;s standing
              instructions, identical on every ticket it picks up.
            </p>
          </div>
          <CopyPromptButton text={composed} />
        </div>
        {/* An 8 KB prompt scrolls INSIDE this box, never the page body.
            `whitespace-pre-wrap`, NOT `pre`: these prompts are mostly prose, and
            with `pre` a real role prompt laid out 4,553px wide in an 846px box —
            every line clipped, horizontal scrolling required to read any of it.
            `pre-wrap` keeps the newlines and indentation that carry the fence
            structure while wrapping long lines to the container. `overflow-auto`
            stays for the residue an unbreakable token (a long URL, a fence rule)
            can still produce. */}
        <pre className="bg-muted/40 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg border p-4 font-mono text-[11px] leading-relaxed">
          {composed}
        </pre>
      </section>

      {/* ── The operator's overlay: the one editable thing on this page ─── */}
      <OverlayEditor
        roleSlug={inspection.slug}
        initialBody={inspection.overlayBody}
        updatedAt={inspection.overlayUpdatedAt}
      />

      {/* ── Skills: named, never spliced in ─────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold tracking-tight">
          Installed skills{" "}
          <span className="text-muted-foreground font-normal tabular-nums">
            ({eligibleSkills.length})
          </span>
        </h2>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{SKILL_DISCLOSURE}</p>
        {eligibleSkills.length === 0 ? (
          <p className="text-muted-foreground mt-3 rounded-lg border border-dashed px-4 py-6 text-center text-xs">
            No installed skill targets this role, so nothing is appended below the prompt above.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {eligibleSkills.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="truncate text-xs font-medium">{s.name}</span>
                <code className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
                  v{s.version}
                </code>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Lessons: a DIFFERENT channel from the system prompt ──────────
          These land in the per-ticket brief via `renderTicketPrompt`, inside
          `fenceUntrustedOutput`, as recalled data the role prompt outranks.
          Bodies ARE shown (short, operator-approved, and the substance of what
          they add) but React escapes them — they are untrusted text. */}
      <section>
        <h2 className="text-sm font-semibold tracking-tight">
          Learned lessons{" "}
          <span className="text-muted-foreground font-normal tabular-nums">
            ({eligibleLessons.length})
          </span>
        </h2>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{LESSON_DISCLOSURE}</p>
        {eligibleLessons.length === 0 ? (
          <p className="text-muted-foreground mt-3 rounded-lg border border-dashed px-4 py-6 text-center text-xs">
            No approved lesson applies to this role yet. Lessons are drafted from what agents get
            wrong and become active once you approve them in Learnings.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {eligibleLessons.map((l) => (
              <li key={l.id} className="rounded-md border px-3 py-2">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={l.scope === "user" ? "violet" : "muted"}>
                    {describeLessonScope(l)}
                  </Badge>
                  <span className="text-muted-foreground text-[10px]">{l.category}</span>
                </div>
                <p className="text-xs leading-relaxed">{l.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
