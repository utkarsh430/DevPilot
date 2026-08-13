"use client";

// The skill authoring form, shared by `/marketplace/new` and
// `/marketplace/[id]/edit`.
//
// One component for both, because create and edit differ only in which action
// fires and whether Delete exists. Two forms would be two places for the
// validation copy, the role picker and the character counter to drift.
//
// Validation runs HERE for live feedback and AGAIN in the action. The server's
// copy is the rule — a forged POST never executes this file — and that split is
// deliberate rather than defensive duplication: the operator gets a per-field
// message as he types, and the stored row is whatever the SERVER normalised.
//
// Delete confirms once, inline, with the consequence stated. No type-to-confirm:
// this removes the operator's own text from his own workspace and stops it being
// added to future prompts, which is nothing like the irreversible-work-loss
// class that earns a typed confirmation (`discardAndRestartFromDevAction`).

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Info, Loader2, Save, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import {
  checkSkillDraft,
  SKILL_BODY_MAX_CHARS,
  SKILL_SUMMARY_MAX_CHARS,
  type SkillFieldViolation,
} from "@/lib/skills/authoring";
import { SKILL_ASSIST_REQUEST_MAX_CHARS } from "@/lib/skills/authoring-assist";
import {
  createSkillAction,
  deleteSkillAction,
  draftSkillAction,
  updateSkillAction,
} from "@/lib/skills/authoring-actions";

const BODY_PLACEHOLDER =
  "e.g. When you touch anything under billing/, re-read the pricing table in " +
  "docs/BILLING.md first — the rounding rules there are not obvious from the " +
  "code, and getting them wrong is silent.";

const ASSIST_PLACEHOLDER =
  "e.g. remind whoever touches billing code to re-read the pricing table in docs/BILLING.md — " +
  "the rounding rules there aren't obvious from the code";

/**
 * A drafted skill, held in browser state only. It is never applied on arrival:
 * the operator reads it, edits it, and presses "Use this" — and even then it
 * only fills the form. Saving is still a separate, explicit press.
 */
type Draft = {
  name: string;
  summary: string;
  body: string;
  targets: string[];
  appliesToAll: boolean;
  triggers: string[];
  rationale: string;
  droppedTargets: string[];
};

export type SkillFormInitial = {
  id: string;
  name: string;
  version: string;
  summary: string;
  body: string;
  targets: string[];
  triggers: string[];
};

export function SkillForm({ initial }: { initial?: SkillFormInitial }) {
  const router = useRouter();
  const [name, setName] = React.useState(initial?.name ?? "");
  const [version, setVersion] = React.useState(initial?.version ?? "1.0.0");
  const [summary, setSummary] = React.useState(initial?.summary ?? "");
  const [body, setBody] = React.useState(initial?.body ?? "");
  const [targets, setTargets] = React.useState<string[]>(initial?.targets ?? []);
  const [triggersText, setTriggersText] = React.useState((initial?.triggers ?? []).join(", "));
  const [serverViolations, setServerViolations] = React.useState<SkillFieldViolation[]>([]);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // ── Assist state ─────────────────────────────────────────────────────────
  const [request, setRequest] = React.useState("");
  const [drafting, setDrafting] = React.useState(false);
  const [draftProposal, setDraftProposal] = React.useState<Draft | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  /**
   * Roles the assist picked, still unreviewed. Kept SEPARATE from `targets` so
   * the picker can say which came from the assist rather than from him — a
   * wrong role narrows the skill silently, so "who chose this" is exactly the
   * thing he needs to see. Cleared the moment he touches the picker himself.
   */
  const [assistTargets, setAssistTargets] = React.useState<string[]>([]);

  const triggers = React.useMemo(
    () =>
      triggersText
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    [triggersText],
  );

  const draft = { name, version, summary, body, targets, triggers };
  const local = checkSkillDraft(draft);
  const liveViolations = local.ok ? [] : local.violations;

  // Live feedback while typing; the server's own verdict takes over once it has
  // answered, so a rejection the client did not predict is still explained.
  const shown = serverViolations.length > 0 ? serverViolations : liveViolations;
  const forField = (f: SkillFieldViolation["field"]) => shown.filter((v) => v.field === f);

  function toggleTarget(slug: string) {
    setServerViolations([]);
    // He has reviewed the suggestion by acting on it; stop attributing the list
    // to the assist from here on.
    setAssistTargets((prev) => prev.filter((s) => s !== slug));
    setTargets((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
  }

  function onDraft() {
    setDrafting(true);
    setRefusal(null);
    setDraftProposal(null);
    void (async () => {
      try {
        const res = await draftSkillAction({ request, currentBody: body });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        if (res.kind === "refused") {
          setRefusal(res.rationale);
          return;
        }
        setDraftProposal({
          name: res.name,
          summary: res.summary,
          body: res.body,
          targets: res.targets,
          appliesToAll: res.appliesToAll,
          triggers: res.triggers,
          rationale: res.rationale,
          droppedTargets: res.droppedTargets,
        });
      } finally {
        setDrafting(false);
      }
    })();
  }

  /**
   * Fill the form from the draft. Nothing is stored: he still presses Save, and
   * the action re-validates everything server-side.
   */
  function useDraft() {
    if (!draftProposal) return;
    setServerViolations([]);
    setName(draftProposal.name);
    setSummary(draftProposal.summary);
    setBody(draftProposal.body);
    setTargets(draftProposal.targets);
    setAssistTargets(draftProposal.targets);
    setTriggersText(draftProposal.triggers.join(", "));
    setDraftProposal(null);
    setRequest("");
  }

  function submit() {
    setServerViolations([]);
    startTransition(async () => {
      const res = initial
        ? await updateSkillAction(initial.id, draft)
        : await createSkillAction(draft);
      if (!res.ok) {
        setServerViolations(res.violations ?? []);
        toast.error(res.error);
        return;
      }
      if (res.warning) toast.warning(res.warning, { duration: 12_000 });
      toast.success(initial ? "Skill saved." : "Skill created.");
      if (!initial) router.push(`/marketplace/${res.id}/edit`);
      router.refresh();
    });
  }

  function remove() {
    if (!initial) return;
    startTransition(async () => {
      const res = await deleteSkillAction(initial.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Skill deleted.");
      router.push("/marketplace");
      router.refresh();
    });
  }

  const overBody = body.length > SKILL_BODY_MAX_CHARS;

  return (
    <div className="space-y-6">
      <FieldNote>
        This skill is private to your workspace. Its text is added to the prompt of every agent run
        it matches, beneath that agent&rsquo;s own instructions — it can add guidance, but it cannot
        grant tools, move a ticket, or override the role&rsquo;s rules.
      </FieldNote>

      {/* ── The plain-English assist ─────────────────────────────────────── */}
      <div className="bg-muted/30 rounded-lg border p-4">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-tight">
          <Sparkles className="h-3.5 w-3.5" />
          Describe it instead
        </h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Say what you want agents to know and DevPilot will draft the skill. You see it before
          anything changes, you can edit every part of it, and nothing is stored until you press
          Save.
        </p>

        <Textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder={ASSIST_PLACEHOLDER}
          rows={2}
          spellCheck
          disabled={drafting || pending}
          maxLength={SKILL_ASSIST_REQUEST_MAX_CHARS}
          aria-label="Describe what this skill should tell an agent"
          className="mt-3 text-xs"
        />
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onDraft}
            disabled={drafting || pending || request.trim().length < 8}
          >
            {drafting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {drafting ? "Thinking…" : "Draft it"}
          </Button>
        </div>

        {/* A refusal is a USEFUL ANSWER — it tells him something true about what
            a skill can and cannot reach — so it renders as information, never
            as a red failure. */}
        {refusal && (
          <div className="bg-background mt-3 flex gap-2 rounded-lg border p-3">
            <Info className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium">A skill can&rsquo;t do that</p>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{refusal}</p>
            </div>
          </div>
        )}

        {draftProposal && (
          <div className="bg-background mt-3 space-y-3 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium">Suggested skill</p>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  {draftProposal.rationale}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Dismiss suggestion"
                onClick={() => setDraftProposal(null)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            <dl className="grid gap-1 text-xs sm:grid-cols-[6rem_1fr]">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-mono">{draftProposal.name}</dd>
              <dt className="text-muted-foreground">Summary</dt>
              <dd>{draftProposal.summary || <span className="text-muted-foreground">—</span>}</dd>
              <dt className="text-muted-foreground">Applies to</dt>
              <dd>
                {draftProposal.appliesToAll ? (
                  <span>
                    Any role
                    <span className="text-muted-foreground">
                      {" "}
                      — the assist judged this general enough not to narrow.
                    </span>
                  </span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {draftProposal.targets.map((slug) => (
                      <Badge key={slug} tone="outline">
                        {ROLE_CATALOG.find((r) => r.slug === slug)?.displayName ?? slug}
                      </Badge>
                    ))}
                  </span>
                )}
              </dd>
            </dl>

            {/* Invented slugs are dropped, and saying so matters: without it,
                "any role" from a wholly hallucinated list is indistinguishable
                from the assist deciding the guidance was general. */}
            {draftProposal.droppedTargets.length > 0 && (
              <p className="text-muted-foreground border-t pt-2 text-xs leading-relaxed">
                {draftProposal.droppedTargets.length === 1
                  ? "One suggested role doesn't exist in DevPilot and was dropped"
                  : `${draftProposal.droppedTargets.length} suggested roles don't exist in DevPilot and were dropped`}{" "}
                (<span className="font-mono">{draftProposal.droppedTargets.join(", ")}</span>).
                Check the list above covers what you meant.
              </p>
            )}

            <div>
              <p className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wide">
                Guidance — edit before or after you use it
              </p>
              <Textarea
                value={draftProposal.body}
                onChange={(e) => setDraftProposal({ ...draftProposal, body: e.target.value })}
                rows={10}
                spellCheck
                aria-label="Suggested guidance, editable"
                className="max-h-64 font-mono text-[11px]"
              />
            </div>

            <div className="flex items-center justify-end gap-2 border-t pt-3">
              <span className="text-muted-foreground mr-auto text-[11px]">
                Using this only fills the form — you still press{" "}
                {initial ? "Save changes" : "Create skill"}.
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setDraftProposal(null)}
              >
                Discard
              </Button>
              <Button type="button" size="sm" onClick={useDraft}>
                Use this
              </Button>
            </div>
          </div>
        )}
      </div>

      <Field label="Name" hint="Lower-case, dashes. Shown to the agent as a one-line label.">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setServerViolations([]);
          }}
          placeholder="staging-smoke-check"
          disabled={pending}
        />
        <Violations items={forField("name")} />
      </Field>

      <Field
        label="Version"
        hint="A label you control. Editing a skill updates it in place — it does not create a second copy."
      >
        <Input
          value={version}
          onChange={(e) => {
            setVersion(e.target.value);
            setServerViolations([]);
          }}
          placeholder="1.0.0"
          disabled={pending}
          className="max-w-40"
        />
        <Violations items={forField("version")} />
      </Field>

      <Field label="Summary" hint="One line, for the catalogue. Not sent to the agent.">
        <Input
          value={summary}
          onChange={(e) => {
            setSummary(e.target.value.slice(0, SKILL_SUMMARY_MAX_CHARS));
            setServerViolations([]);
          }}
          placeholder="Check the staging deploy actually serves before reporting success."
          disabled={pending}
        />
        <Violations items={forField("summary")} />
      </Field>

      <Field
        label="Guidance"
        hint="What this skill should tell a matching agent. This is the part the agent reads."
      >
        <Textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setServerViolations([]);
          }}
          placeholder={BODY_PLACEHOLDER}
          rows={12}
          disabled={pending}
          className="font-mono text-xs"
        />
        <div className="flex items-center justify-between">
          <Violations items={forField("body")} />
          <span
            className={`shrink-0 text-xs tabular-nums ${
              overBody ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {body.length.toLocaleString()} / {SKILL_BODY_MAX_CHARS.toLocaleString()}
          </span>
        </div>
      </Field>

      <Field
        label="Applies to"
        hint="Leave every role unpicked to consider this skill for any role."
      >
        {/* Suggested roles are attributed, not blended in. Picking the wrong
            role is silent — the skill just never reaches the agent that needed
            it — so he has to be able to tell his own choices from a guess. */}
        {assistTargets.length > 0 && (
          <div className="bg-muted/40 flex gap-2 rounded-md border p-2.5 text-xs">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p className="text-muted-foreground leading-relaxed">
              The highlighted roles were suggested by the assist, not chosen by you.{" "}
              <strong className="text-foreground font-medium">Check them before you save</strong> —
              a role that should be here and isn&rsquo;t means this skill silently never reaches it.
              Unpick them all to consider this skill for every role.
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {ROLE_CATALOG.map((r) => {
            const on = targets.includes(r.slug);
            const suggested = assistTargets.includes(r.slug);
            return (
              <button
                key={r.slug}
                type="button"
                disabled={pending}
                onClick={() => toggleTarget(r.slug)}
                title={suggested ? `Suggested by the assist — ${r.purpose}` : r.purpose}
                aria-pressed={on}
              >
                <Badge
                  tone={on ? "info" : "outline"}
                  className={`cursor-pointer ${suggested ? "ring-primary/60 ring-1" : ""}`}
                >
                  {suggested ? <Sparkles className="h-2.5 w-2.5" /> : null}
                  {r.displayName}
                </Badge>
              </button>
            );
          })}
        </div>
        {targets.length === 0 && (
          <p className="text-muted-foreground text-xs">
            No roles picked — every role considers this skill.
          </p>
        )}
        <Violations items={forField("targets")} />
      </Field>

      <Field
        label="Trigger keywords"
        hint="Comma-separated. A ticket mentioning one of these makes this skill more likely to be picked."
      >
        <Input
          value={triggersText}
          onChange={(e) => {
            setTriggersText(e.target.value);
            setServerViolations([]);
          }}
          placeholder="deploy, staging, release"
          disabled={pending}
        />
        <Violations items={forField("triggers")} />
      </Field>

      <div className="flex items-center gap-2 border-t pt-4">
        <Button onClick={submit} disabled={pending || !local.ok}>
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {initial ? "Save changes" : "Create skill"}
        </Button>

        {initial ? (
          confirmDelete ? (
            <div className="border-destructive/40 bg-destructive/5 flex items-center gap-2 rounded-md border px-2 py-1">
              <span className="text-muted-foreground text-xs">
                Delete this skill? Agents stop receiving it on their next run.
              </span>
              <Button size="sm" variant="destructive" onClick={remove} disabled={pending}>
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
                disabled={pending}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )
        ) : null}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {children}
    </div>
  );
}

function FieldNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted/40 text-muted-foreground flex gap-2 rounded-md border p-3 text-xs">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

function Violations({ items }: { items: SkillFieldViolation[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1">
      {items.map((v, i) => (
        <li key={i} className="text-destructive flex gap-1.5 text-xs">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{v.message}</span>
        </li>
      ))}
    </ul>
  );
}
