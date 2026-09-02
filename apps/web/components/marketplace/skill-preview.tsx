// The skill review surface.
//
// The marketplace tells operators "review the body before installing", and that
// sentence is the whole safety story for a skill: a body is prompt content that
// `mergeSkillsIntoSystemPrompt` splices into a role's system prompt at dispatch.
// An instruction nobody can practically follow is decoration, so this panel is
// built to make following it cheap — the full body at readable width, the two
// facts that decide WHEN it reaches a model (roles + triggers), a plain
// statement of what installing does, and a comparison against the copy already
// installed when the two have drifted apart.
//
// Deliberately free of Radix primitives and of any browser API: the caller
// wraps it in a Dialog, and keeping this half plain is what lets
// `lib/marketplace/__tests__/skill-preview-render.test.ts` render it with
// `renderToStaticMarkup` under the repo's node-environment Vitest, with no
// jsdom and no React Testing Library.
//
// Overflow contract (the page body must never scroll horizontally): a skill
// body is arbitrary text with arbitrary long lines. Every column on the path to
// the body pane carries `min-w-0` — without it a flex/grid child refuses to
// shrink below its content and pushes the page wide — and the body itself sits
// in its OWN `overflow-auto` box with `whitespace-pre-wrap` + `break-words`, so
// long lines wrap and anything unwrappable scrolls inside that box rather than
// the document.

import * as React from "react";
import { ShieldAlert, Sparkles, Target, Zap, GitCompare, PackagePlus } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SkillRow } from "@/lib/skills/types";
import {
  compareWithInstalled,
  describeBodySize,
  describeSkillReach,
  describeSkillTriggers,
} from "@/lib/marketplace/skill-view";

export type SkillPreviewProps = {
  skill: SkillRow;
  /** The tenant's copy, when one exists — drives the drift comparison. */
  installed?: SkillRow | null;
  /** slug → display name, from the role catalog. */
  labelFor: (slug: string) => string;
};

export function SkillPreview({ skill, installed, labelFor }: SkillPreviewProps) {
  const reach = describeSkillReach(skill.targets);
  const triggers = describeSkillTriggers(skill.triggers);
  const size = describeBodySize(skill.body);
  const comparison = compareWithInstalled(skill.body, installed);
  const summary = typeof skill.manifest?.summary === "string" ? skill.manifest.summary : "";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {summary && <p className="text-muted-foreground min-w-0 text-sm">{summary}</p>}

      {/* ---- When this fires -------------------------------------------- */}
      <section className="min-w-0">
        <SectionHeading icon={<Target className="h-3.5 w-3.5" />} title="When this fires" />
        <div className="border-border min-w-0 space-y-3 rounded-lg border p-3">
          <Fact label="Roles">
            {reach.allRoles ? (
              // The load-bearing case. Empty targets means EVERY role in
              // `keywordFilter`, so this is the widest-reaching kind of skill in
              // the catalog and it must not read as "attaches to nothing".
              <span className="text-warning inline-flex items-center gap-1.5 text-xs font-semibold">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                Every role — this skill has no role targets
              </span>
            ) : (
              <span className="flex min-w-0 flex-wrap gap-1">
                {reach.roles.map((r) => (
                  <span
                    key={r}
                    className="border-border bg-muted text-muted-foreground inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                  >
                    {labelFor(r)}
                  </span>
                ))}
              </span>
            )}
          </Fact>

          <Fact label="Triggers">
            {triggers.length === 0 ? (
              <span className="text-muted-foreground text-xs">
                None — eligible on role alone, with no keyword narrowing.
              </span>
            ) : (
              <span className="flex min-w-0 flex-wrap gap-1">
                {triggers.map((t) => (
                  <span
                    key={t}
                    className="border-border bg-background text-foreground inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 font-mono text-[10px]"
                  >
                    <Zap className="h-2.5 w-2.5 shrink-0" aria-hidden />
                    {t}
                  </span>
                ))}
              </span>
            )}
          </Fact>

          <p className="text-muted-foreground border-border border-t pt-2 text-[11px] leading-relaxed">
            At dispatch the selector keeps skills whose roles match the ticket&apos;s role, scores
            each by how many trigger words appear in the ticket text, and merges the top few bodies
            into that role&apos;s system prompt. Only skills installed in this tenant are
            considered.
          </p>
        </div>
      </section>

      {/* ---- What installing changes ------------------------------------ */}
      <section className="min-w-0">
        <SectionHeading
          icon={<PackagePlus className="h-3.5 w-3.5" />}
          title="What installing changes"
        />
        <ul className="text-muted-foreground border-border min-w-0 list-disc space-y-1 rounded-lg border p-3 pl-7 text-xs leading-relaxed">
          <li>Copies this row into your tenant. The public entry is never modified.</li>
          <li>
            The copy becomes eligible at dispatch — the public entry never is, so installing is the
            consent step.
          </li>
          <li>
            The body is added as guidance under a fenced heading. It cannot grant tools, change the
            ticket state machine, or override the role&apos;s contract.
          </li>
          <li>Uninstalling deletes your copy and stops it reaching any future dispatch.</li>
        </ul>
      </section>

      {/* ---- Drift against the installed copy ---------------------------- */}
      {comparison === "differs" && installed && (
        <section className="min-w-0">
          <SectionHeading
            icon={<GitCompare className="h-3.5 w-3.5" />}
            title="Your installed copy differs"
          />
          <div className="border-warning/30 bg-warning/10 min-w-0 rounded-lg border p-3">
            <p className="text-foreground/90 text-xs leading-relaxed">
              The copy installed in this tenant (v{installed.version}) does not match this public
              body. Either the public entry changed after you installed it, or your copy was edited.
              Your copy is what agents actually receive.
            </p>
            <details className="mt-2 min-w-0">
              <summary className="text-foreground cursor-pointer text-xs font-medium">
                Show the installed body
              </summary>
              <BodyPane body={installed.body} label="Installed body" />
            </details>
          </div>
        </section>
      )}
      {comparison === "identical" && (
        <p className="text-muted-foreground text-xs">
          Your installed copy matches this body exactly.
        </p>
      )}

      {/* ---- The body --------------------------------------------------- */}
      <section className="min-w-0">
        <SectionHeading
          icon={<ShieldAlert className="text-warning h-3.5 w-3.5" />}
          title="Body — this text is merged into a system prompt"
          meta={`${size.chars.toLocaleString()} characters · ${size.lines.toLocaleString()} lines`}
        />
        <BodyPane body={skill.body} label="Skill body" />
      </section>
    </div>
  );
}

function SectionHeading({
  icon,
  title,
  meta,
}: {
  icon: React.ReactNode;
  title: string;
  meta?: string;
}) {
  return (
    <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h3 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-tight">
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0">{title}</span>
      </h3>
      {meta && (
        <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
          {meta}
        </span>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
      <span className="text-muted-foreground w-20 shrink-0 text-[11px] font-medium uppercase tracking-wide">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The body pane. `overflow-auto` + a height cap keep an 8,000-character body
 * scrolling inside this box; `whitespace-pre-wrap break-words` keeps a single
 * 400-character line from widening the document.
 */
function BodyPane({ body, label, className }: { body: string; label: string; className?: string }) {
  return (
    <pre
      aria-label={label}
      className={cn(
        "bg-muted/40 text-foreground min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-[11px] leading-relaxed",
        "max-h-[45vh]",
        className,
      )}
    >
      {body}
    </pre>
  );
}
