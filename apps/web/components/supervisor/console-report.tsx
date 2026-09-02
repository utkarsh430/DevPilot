// The supervisor console's deterministic panel: what the board is doing, and
// what can be done about it. PRESENTATIONAL - no hooks, no browser API, no
// `server-only`, no provider-bearing primitive.
//
// That constraint is forced by the test runner, not by taste: Vitest here
// collects only `lib/**/__tests__/**/*.test.ts` in a NODE environment, so a
// component with state can be asserted by nothing. Keeping this half pure is
// what lets `lib/supervisor/__tests__/console-report-render.test.ts` drive the
// REAL component with `renderToStaticMarkup` (the `skill-preview-render.test.ts`
// shape). Move one line of state in here and it silently leaves the suite.
//
// ── IT RENDERS WITHOUT THE MODEL, AND THAT IS THE POINT ───────────────────
// Everything here is computed from the database by pure code. When the LLM is
// unreachable - a state that correlates with the board being broken, since both
// depend on the runner - the console still answers "what is this board doing"
// and still offers every action. The model adds prose on top; it is never the
// thing that makes the surface work.

import * as React from "react";
import { AlertTriangle, CircleSlash, Loader2, User, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { ConsoleBrief } from "@/lib/supervisor/console-view";
import type { ConsoleAction } from "@/lib/supervisor/console-actions";
import { CONFIRM_ACK_TOKEN, type ConsoleCommand } from "@/lib/supervisor/console-commands";

/**
 * The engine-health strip.
 *
 * Silent when healthy. A row that is always present teaches an operator to skip
 * it, and this is the one fact that, when true, makes every other number on the
 * board a consequence rather than a cause - so it has to read as an exception.
 *
 * `unknown` is shown, not hidden: "we could not tell whether the safety nets are
 * running" is materially different from "they are", and reading the first as the
 * second is exactly the fail-open the autonomous supervisor refuses.
 */
export function EngineStrip({ engine }: { engine: ConsoleBrief["engine"] }) {
  if (engine.state === "alive") return null;
  const wedged = engine.state === "wedged";
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        wedged
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <div className="font-medium">
          {wedged
            ? "The engine's scheduled recovery has stopped."
            : "The engine's scheduled recovery could not be confirmed."}
        </div>
        <p className="mt-0.5 opacity-90">
          {wedged
            ? "The stuck-ticket sweeper, the orphan, stale-run and land reapers, the dispatch rescue and the runner watchdog are all crons on the same scheduler. Nothing on this board will self-heal until it is running again."
            : "Treat automatic recovery as unproven rather than working."}{" "}
          <span className="opacity-75">({engine.detail})</span>
        </p>
      </div>
    </div>
  );
}

const WAITING_TONE = {
  nobody: "text-destructive",
  human: "text-amber-600 dark:text-amber-400",
  machine: "text-muted-foreground",
} as const;

/**
 * The three counts, and they are the whole summary.
 *
 * A board with twelve stopped tickets is a completely different situation
 * depending on whether they are stopped on a process, on a person, or on
 * nothing - because the remedies are disjoint: wait, act, or investigate.
 * Collapsing them into one "stuck" number is what makes a board summary
 * useless, so the split is the headline rather than a detail.
 */
export function WaitingCounts({ summary }: { summary: ConsoleBrief["summary"] }) {
  const rows = [
    {
      key: "nobody" as const,
      icon: CircleSlash,
      label: "Nobody",
      hint: "nothing owns these - they will not move on their own",
      n: summary.byWaitingOn.nobody,
    },
    {
      key: "human" as const,
      icon: User,
      label: "You",
      hint: "a gate refused, a question was asked, or it is paused",
      n: summary.byWaitingOn.human,
    },
    {
      key: "machine" as const,
      icon: Wrench,
      label: "The machine",
      hint: "running, queued, or waiting on upstream work",
      n: summary.byWaitingOn.machine,
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {rows.map((r) => {
        const Icon = r.icon;
        return (
          <div key={r.key} className="bg-muted/40 rounded-lg border px-3 py-2">
            <div className={cn("flex items-center gap-1.5 text-xs", WAITING_TONE[r.key])}>
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="font-medium">{r.label}</span>
            </div>
            <div
              className={cn(
                "font-display mt-1 text-2xl leading-none",
                r.n > 0 ? WAITING_TONE[r.key] : "text-muted-foreground/50",
              )}
            >
              {r.n}
            </div>
            <p className="text-muted-foreground mt-1 text-[11px] leading-snug">{r.hint}</p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The alarm list: tickets nothing owns.
 *
 * Rendered as its own block rather than folded into a table, because it is the
 * only section whose absence is good news - and an empty section that still
 * draws a heading is how "nothing is wrong" starts looking like "something is
 * wrong". So it renders nothing at all when the set is empty.
 */
export function UnownedList({ summary }: { summary: ConsoleBrief["summary"] }) {
  if (summary.unowned.length === 0) return null;
  return (
    <div className="border-destructive/30 bg-destructive/5 rounded-lg border">
      <div className="border-destructive/20 text-destructive border-b px-3 py-1.5 text-xs font-medium">
        Nothing is working on these, and nothing is scheduled to
      </div>
      <ul className="divide-border divide-y">
        {summary.unowned.map((u) => (
          <li key={u.key} className="px-3 py-2 text-xs">
            <span className="font-mono font-medium">{u.key}</span>
            <span className="text-muted-foreground"> · {u.kind.replace(/_/g, " ")}</span>
            <p className="text-muted-foreground mt-0.5 leading-snug">{u.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The action list.
 *
 * `consequence` is rendered NEXT TO the button, always, never behind a tooltip.
 * An operator has to be able to decline from the description alone - these move
 * tickets on a live board, and a label like "Unstick DevPilot-27" does not say
 * that the ticket comes back to them rather than being re-run.
 *
 * When supervision is off the buttons are DISABLED with the reason stated,
 * rather than hidden: hiding them would make the console look as though it had
 * nothing to offer, when in fact the operator has one switch to flip.
 */
export function ActionList({
  actions,
  supervisorEnabled,
  runningId,
  onRun,
  emphasisIds,
}: {
  actions: readonly ConsoleAction[];
  supervisorEnabled: boolean;
  runningId?: string | null;
  onRun?: (action: ConsoleAction) => void;
  /** Ids the console recommended for the current question - shown first and
   *  marked, so a recommendation and the button that enacts it are the same
   *  object rather than two lists an operator has to reconcile. */
  emphasisIds?: readonly string[];
}) {
  if (actions.length === 0) return null;
  const emphasis = new Set(emphasisIds ?? []);
  const ordered = [...actions].sort(
    (a, b) => Number(emphasis.has(b.id)) - Number(emphasis.has(a.id)),
  );
  return (
    <div className="rounded-lg border">
      <div className="text-muted-foreground border-b px-3 py-1.5 text-xs font-medium">
        What I can do about it
      </div>
      {!supervisorEnabled ? (
        <p className="text-muted-foreground border-b px-3 py-2 text-[11px] leading-snug">
          Supervision is off for this project, so these are disabled. Turn it on in the project
          settings to let the console act on this board. Explanations do not need it.
        </p>
      ) : null}
      <ul className="divide-border divide-y">
        {ordered.map((a) => (
          <li key={a.id} className="flex items-start gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                {a.label}
                {emphasis.has(a.id) ? (
                  <span className="bg-primary/15 text-primary rounded px-1 py-px text-[10px] font-medium">
                    recommended
                  </span>
                ) : null}
              </div>
              <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
                {a.consequence}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={!supervisorEnabled || Boolean(runningId)}
              onClick={onRun ? () => onRun(a) : undefined}
            >
              {runningId === a.id ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
                </>
              ) : (
                "Run"
              )}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Commands
// ───────────────────────────────────────────────────────────────────────────

/**
 * One command's operator-supplied fields. CONTROLLED - the values and the
 * setter come from the stateful shell, so this stays hook-free and therefore
 * inside the render suite.
 *
 * Generic over the field list rather than one component per command: a command
 * declares its fields in `console-commands.ts`, so adding one needs no UI at
 * all - and, more usefully, a command cannot ship a field the server does not
 * validate, because the server validates against this same list.
 */
export function CommandFields({
  command,
  values,
  onChange,
  disabled,
}: {
  command: ConsoleCommand;
  values: Record<string, string | string[] | number>;
  onChange: (name: string, value: string | string[] | number) => void;
  disabled?: boolean;
}) {
  if (command.fields.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {command.fields.map((f) => {
        const id = `${command.id}:${f.name}`;
        const label = (
          <label htmlFor={id} className="text-muted-foreground text-[11px] font-medium">
            {f.label}
            {f.help ? <span className="ml-1 font-normal opacity-80">{f.help}</span> : null}
          </label>
        );

        if (f.kind === "text") {
          const v = typeof values[f.name] === "string" ? (values[f.name] as string) : "";
          return (
            <div key={f.name} className="flex flex-col gap-1">
              {label}
              {f.multiline ? (
                <textarea
                  id={id}
                  rows={3}
                  value={v}
                  maxLength={f.maxChars}
                  placeholder={f.placeholder}
                  disabled={disabled}
                  onChange={(e) => onChange(f.name, e.target.value)}
                  className="border-input bg-background w-full resize-y rounded-md border px-2 py-1.5 text-xs"
                />
              ) : (
                <input
                  id={id}
                  type="text"
                  value={v}
                  maxLength={f.maxChars}
                  placeholder={f.placeholder}
                  disabled={disabled}
                  onChange={(e) => onChange(f.name, e.target.value)}
                  className="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs"
                />
              )}
            </div>
          );
        }

        if (f.kind === "select") {
          const v =
            typeof values[f.name] === "string"
              ? (values[f.name] as string)
              : (f.defaultValue ?? "");
          return (
            <div key={f.name} className="flex flex-col gap-1">
              {label}
              <select
                id={id}
                value={v}
                disabled={disabled}
                onChange={(e) => onChange(f.name, e.target.value)}
                className="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs"
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (f.kind === "multiselect") {
          const chosen = Array.isArray(values[f.name]) ? (values[f.name] as string[]) : [];
          return (
            <div key={f.name} className="flex flex-col gap-1">
              {label}
              {/* ORDER IS MEANINGFUL and the copy says so: the first pick is the
                  lead the dispatcher fires the cohort from, so the control
                  appends rather than sorting. */}
              <div className="flex flex-wrap gap-1">
                {f.options.map((o) => {
                  const at = chosen.indexOf(o.value);
                  const on = at >= 0;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      disabled={disabled || (!on && chosen.length >= f.max)}
                      onClick={() =>
                        onChange(
                          f.name,
                          on ? chosen.filter((c) => c !== o.value) : [...chosen, o.value],
                        )
                      }
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40",
                        on
                          ? "border-primary bg-primary/15 text-primary font-medium"
                          : "border-border text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {on ? `${at + 1}. ` : ""}
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }

        const n = typeof values[f.name] === "number" ? (values[f.name] as number) : f.defaultValue;
        return (
          <div key={f.name} className="flex flex-col gap-1">
            {label}
            <input
              id={id}
              type="number"
              value={n}
              min={f.min}
              max={f.max}
              disabled={disabled}
              onChange={(e) => onChange(f.name, Number(e.target.value))}
              className="border-input bg-background w-32 rounded-md border px-2 py-1.5 text-xs"
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The command list - what the operator may do to the tickets THEY NAMED.
 *
 * Two things this renders that the action list does not, and both are load-
 * bearing rather than decoration:
 *
 *  • THE CONFIRMATION IS VISIBLE BEFORE THE BUTTON IS. An `acknowledge` command
 *    says so; a `type_to_confirm` command shows the box that must be filled and
 *    names the exact string. An operator should never discover that something
 *    was irreversible by having it refuse them afterwards.
 *  • THE PROVENANCE OF THE TARGET IS STATED. The heading says these exist
 *    because of what the operator wrote. That is the sentence that makes the
 *    absence of a command legible: if a ticket they can see has no command, it
 *    is because they did not name it, not because the console is broken.
 */
export function CommandList({
  commands,
  supervisorEnabled,
  runningId,
  values,
  confirmations,
  onChangeField,
  onChangeConfirmation,
  onRun,
  emphasisIds,
}: {
  commands: readonly ConsoleCommand[];
  supervisorEnabled: boolean;
  runningId?: string | null;
  values: Record<string, Record<string, string | string[] | number>>;
  confirmations: Record<string, string>;
  onChangeField?: (commandId: string, name: string, value: string | string[] | number) => void;
  onChangeConfirmation?: (commandId: string, value: string) => void;
  onRun?: (command: ConsoleCommand) => void;
  emphasisIds?: readonly string[];
}) {
  if (commands.length === 0) return null;
  const emphasis = new Set(emphasisIds ?? []);
  const ordered = [...commands].sort(
    (a, b) => Number(emphasis.has(b.id)) - Number(emphasis.has(a.id)),
  );
  return (
    <div className="rounded-lg border">
      <div className="text-muted-foreground border-b px-3 py-1.5 text-xs font-medium">
        Commands for what you just asked
      </div>
      <p className="text-muted-foreground border-b px-3 py-2 text-[11px] leading-snug">
        These exist because of the tickets you named. A ticket you can see in the report but did not
        name has no command here — name it and ask again.
      </p>
      {!supervisorEnabled ? (
        <p className="text-muted-foreground border-b px-3 py-2 text-[11px] leading-snug">
          Supervision is off for this project, so these are disabled. Turn it on in the project
          settings to let the console act on this board. Explanations do not need it.
        </p>
      ) : null}
      <ul className="divide-border divide-y">
        {ordered.map((c) => {
          const ack = c.confirmation === "acknowledge";
          const typed = c.confirmation === "type_to_confirm";
          const confirmation = confirmations[c.id] ?? "";
          const armed =
            c.confirmation === "none" ||
            (ack && confirmation === CONFIRM_ACK_TOKEN) ||
            (typed && confirmation.trim().toLowerCase() === (c.ticketKey ?? "").toLowerCase());
          return (
            <li key={c.id} className="px-3 py-2.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                    {c.label}
                    {emphasis.has(c.id) ? (
                      <span className="bg-primary/15 text-primary rounded px-1 py-px text-[10px] font-medium">
                        recommended
                      </span>
                    ) : null}
                    {typed ? (
                      <span className="bg-destructive/15 text-destructive rounded px-1 py-px text-[10px] font-medium">
                        irreversible
                      </span>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
                    {c.consequence}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={typed ? "destructive" : "outline"}
                  className="shrink-0"
                  disabled={!supervisorEnabled || Boolean(runningId) || !armed}
                  onClick={onRun ? () => onRun(c) : undefined}
                >
                  {runningId === c.id ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
                    </>
                  ) : (
                    "Run"
                  )}
                </Button>
              </div>

              <CommandFields
                command={c}
                values={values[c.id] ?? {}}
                disabled={!supervisorEnabled || Boolean(runningId)}
                onChange={
                  onChangeField ? (name, value) => onChangeField(c.id, name, value) : () => {}
                }
              />

              {ack ? (
                <label className="text-muted-foreground mt-2 flex items-center gap-1.5 text-[11px]">
                  <input
                    type="checkbox"
                    checked={confirmation === CONFIRM_ACK_TOKEN}
                    disabled={!supervisorEnabled || Boolean(runningId)}
                    onChange={(e) =>
                      onChangeConfirmation?.(c.id, e.target.checked ? CONFIRM_ACK_TOKEN : "")
                    }
                  />
                  I understand what this will do.
                </label>
              ) : null}

              {typed ? (
                <div className="mt-2 flex flex-col gap-1">
                  <label
                    htmlFor={`${c.id}:confirm`}
                    className="text-destructive text-[11px] font-medium"
                  >
                    This cannot be undone. Type {c.ticketKey} to confirm.
                  </label>
                  <input
                    id={`${c.id}:confirm`}
                    type="text"
                    value={confirmation}
                    placeholder={c.ticketKey}
                    disabled={!supervisorEnabled || Boolean(runningId)}
                    onChange={(e) => onChangeConfirmation?.(c.id, e.target.value)}
                    className="border-destructive/50 bg-background w-48 rounded-md border px-2 py-1.5 font-mono text-xs"
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The whole deterministic panel. */
export function ConsoleReport({
  brief,
  runningId,
  onRun,
  emphasisIds,
  children,
}: {
  brief: ConsoleBrief;
  runningId?: string | null;
  onRun?: (action: ConsoleAction) => void;
  emphasisIds?: readonly string[];
  /** The COMMAND list, injected rather than read from `brief`. It belongs to one
   *  operator message (its ticket-scoped members exist only for tickets that
   *  message named), while the brief is the always-current board read - so the
   *  two have different lifetimes and must not be carried on one object. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <EngineStrip engine={brief.engine} />
      <p className="text-foreground text-sm leading-snug">{brief.summary.headline}</p>
      <WaitingCounts summary={brief.summary} />
      <UnownedList summary={brief.summary} />
      <ActionList
        actions={brief.actions}
        supervisorEnabled={brief.supervisorEnabled}
        runningId={runningId}
        onRun={onRun}
        emphasisIds={emphasisIds}
      />
      {children}
      {brief.truncated ? (
        <p className="text-muted-foreground text-[11px]">
          This board has more tickets than one read covers, so the counts above are a floor, not a
          total.
        </p>
      ) : null}
    </div>
  );
}
