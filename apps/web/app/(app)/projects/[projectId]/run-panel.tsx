"use client";

// Phase 2 / M5e — Run on localhost panel.
//
// Rendered in two places by B5 (the orchestrator wires both):
//   • /projects/[projectId]                  — scope = "project"
//   • /changes/[pendingPushId]               — scope = "pending_push"
//
// One client component, four states driven by the realtime hook's snapshot:
//   • idle      (no session OR status in 'stopped' | 'errored' for non-current) — Run button + optional command override.
//   • starting  — spinner + "Probing port and spawning…" + Stop button.
//   • running   — green LiveDot + URL + Copy / Open / Stop + collapsed log tail.
//   • errored   — red dot + statusReason + Restart button + expanded log tail.
//
// Interaction ping
// ────────────────
// While a session is starting/running and the operator has the panel
// mounted, we ping `pingDevServerInteractionAction` every 60s. That keeps
// the idle reaper (30 min of no interaction) off our back without burdening
// the runner heartbeat path. Unmount cancels the timer.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Play,
  StopCircle,
  Copy,
  ExternalLink,
  Code2,
  Loader2,
  AlertCircle,
  RefreshCw,
  Terminal,
  GitBranch,
  ChevronDown,
  Check,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
// Slice C — server action that hands back a vscode:// URL after RLS gate.
import { getVscodeOpenUrlAction } from "@/lib/workspace/open-actions";
import { toast } from "@/components/ui/sonner";
import { useLiveDevServer, type DevServerScope } from "@/lib/realtime/use-live-dev-server";
import {
  pingDevServerInteractionAction,
  startDevServerForProjectAction,
  stopDevServerAction,
  listProjectBranchesAction,
  switchDevServerBranchAction,
} from "./run-actions";
import { setProjectSecretAction } from "./secret-actions";

// Tiny live-pulse dot. Mirrors `LiveDot` in `components/runs/RunInspector.tsx`
// but with a configurable tone so we can paint amber for "starting" and red
// for "errored" without forking the component.
function StatusDot({
  tone,
  pulse,
  title,
}: {
  tone: "success" | "warning" | "destructive" | "muted";
  pulse: boolean;
  title: string;
}) {
  const dotColor =
    tone === "success"
      ? "bg-success"
      : tone === "warning"
        ? "bg-warning"
        : tone === "destructive"
          ? "bg-destructive"
          : "bg-muted-foreground";
  return (
    <span
      className="relative inline-flex h-2 w-2"
      title={title}
      aria-label={title}
      aria-live="polite"
    >
      {pulse ? (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dotColor}`}
        />
      ) : null}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${dotColor}`} />
    </span>
  );
}

/**
 * Shared branch-list loader for both branch pickers below. Lazy-loads the
 * project's GitHub branches when `open` flips true (re-fetches every open so
 * freshly-pushed branches show up; the API call is cheap), then orders them:
 * the scope's own branch first when there is one (tagged "this change"), then
 * defaultBranch + integrationBranch (tagged "production" / "integration"), the
 * rest alphabetical.
 *
 * `scopeBranch` (WI-10) is the branch the mounting scope is pinned to — a
 * pending push's `devpilot/<slug>`. It is listed even when GitHub doesn't know it,
 * because a never-pushed feature branch exists only in the workspace and is
 * exactly the branch the operator needs to get back to after previewing `dev`.
 */
function useOrderedBranches({
  projectId,
  open,
  defaultBranch,
  integrationBranch,
  scopeBranch,
}: {
  projectId: string;
  open: boolean;
  defaultBranch: string;
  integrationBranch: string | null;
  scopeBranch?: string | null;
}) {
  const [branches, setBranches] = React.useState<Array<{ name: string; protected: boolean }>>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await listProjectBranchesAction({ projectId });
      if (cancelled) return;
      if (res.ok) setBranches(res.branches);
      else toast.error("Couldn't list branches", { description: res.error });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const ordered = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{
      name: string;
      protected: boolean;
      tag?: string;
    }> = [];
    const push = (name: string, p: boolean, tag?: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      out.push({ name, protected: p, tag });
    };
    // Special pinned entries — the scope's own branch, then defaultBranch +
    // integrationBranch. The scope branch is pushed from the prop, not from the
    // fetched list, so an unpushed feature branch still shows up.
    if (scopeBranch) {
      const known = branches.find((b) => b.name === scopeBranch);
      push(scopeBranch, known?.protected ?? false, "this change");
    }
    const def = branches.find((b) => b.name === defaultBranch);
    if (def) push(def.name, def.protected, "production");
    if (integrationBranch) {
      const integ = branches.find((b) => b.name === integrationBranch);
      if (integ) push(integ.name, integ.protected, "integration");
    }
    // Rest alphabetical.
    const rest = branches
      .filter((b) => !seen.has(b.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const b of rest) push(b.name, b.protected);
    return out;
  }, [branches, defaultBranch, integrationBranch, scopeBranch]);

  return { ordered, loading };
}

/**
 * Branch picker — popover dropdown listing the project's GitHub branches.
 * On select, calls `switchDevServerBranchAction` which stops the current
 * session, checks out the new branch in the workspace, and starts a new
 * session row pointing at the same workspace + new branch. The realtime
 * subscription then picks up the new session automatically.
 *
 * Renders only in the running/errored states — there's no useful semantic
 * for "switch branch" when the dev server isn't running. For picking a
 * branch *before* the first run, see `IdleBranchPicker` below.
 */
function BranchPicker({
  sessionId,
  currentBranch,
  projectId,
  defaultBranch,
  integrationBranch,
  scopeBranch,
}: {
  sessionId: string;
  currentBranch: string;
  projectId: string;
  defaultBranch: string;
  integrationBranch: string | null;
  scopeBranch?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [switching, setSwitching] = React.useState<string | null>(null);
  const { ordered, loading } = useOrderedBranches({
    projectId,
    open,
    defaultBranch,
    integrationBranch,
    scopeBranch,
  });

  const router = useRouter();
  async function onPick(branch: string) {
    if (branch === currentBranch) {
      setOpen(false);
      return;
    }
    setSwitching(branch);
    const res = await switchDevServerBranchAction({ sessionId, branch });
    setSwitching(null);
    if (!res.ok) {
      toast.error("Branch switch failed", { description: res.error });
      return;
    }
    toast.success(`Switched to ${branch}`, {
      description: "Restarting dev server…",
    });
    setOpen(false);
    // 2026-06-08 hotfix — force a server-rendered re-fetch so the panel
    // snaps to the new session immediately instead of waiting for the
    // realtime INSERT to arrive (which can lag a beat under hot-reload
    // or supabase queue saturation, leaving the picker pill stale).
    router.refresh();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="bg-card/60 hover:bg-card inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
          aria-label="Switch branch"
        >
          <GitBranch className="text-muted-foreground h-3 w-3 shrink-0" />
          <span className="truncate font-mono text-[11px]">{currentBranch}</span>
          <ChevronDown className="text-muted-foreground h-3 w-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <div className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
            Switch branch
          </div>
          <div className="text-muted-foreground mt-0.5 text-[10px]">
            Stops the server, checks out the new branch, restarts.
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {loading ? (
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading branches…
            </div>
          ) : ordered.length === 0 ? (
            <div className="text-muted-foreground px-3 py-2 text-xs italic">No branches found.</div>
          ) : (
            <ul className="flex flex-col">
              {ordered.map((b) => {
                const isCurrent = b.name === currentBranch;
                const isSwitching = switching === b.name;
                return (
                  <li key={b.name}>
                    <button
                      type="button"
                      onClick={() => onPick(b.name)}
                      disabled={switching !== null}
                      className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs disabled:opacity-50"
                    >
                      {isCurrent ? (
                        <Check className="text-success h-3 w-3 shrink-0" />
                      ) : isSwitching ? (
                        <Loader2 className="text-foreground h-3 w-3 shrink-0 animate-spin" />
                      ) : (
                        <span className="inline-block h-3 w-3 shrink-0" />
                      )}
                      <span className="flex-1 truncate font-mono">{b.name}</span>
                      {b.protected ? (
                        <Shield
                          className="text-muted-foreground h-3 w-3 shrink-0"
                          aria-label="protected"
                        />
                      ) : null}
                      {b.tag ? (
                        <Badge tone="muted" className="text-[9px]">
                          {b.tag}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * WI-9 — idle-state branch picker. Lets the operator choose which branch a run
 * will serve *before* hitting Run, instead of always landing on the
 * scope-dictated default and having to switch after via `BranchPicker`. Purely
 * local state — the pick only takes effect on the next `onStart` call, no server
 * round trip until then.
 *
 * WI-10 — also rendered for a pending-push scope, where the scope's default is
 * the change's own feature branch (`scopeBranch`) and picking anything else
 * previews that branch in the same workspace. The server checks it out
 * non-destructively; unpushed commits stay put.
 */
function IdleBranchPicker({
  projectId,
  defaultBranch,
  integrationBranch,
  scopeBranch,
  selected,
  onSelect,
  disabled,
}: {
  projectId: string;
  defaultBranch: string;
  integrationBranch: string | null;
  scopeBranch?: string | null;
  selected: string;
  onSelect: (branch: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const { ordered, loading } = useOrderedBranches({
    projectId,
    open,
    defaultBranch,
    integrationBranch,
    scopeBranch,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="bg-card/60 hover:bg-card inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
          aria-label="Choose branch to run"
        >
          <GitBranch className="text-muted-foreground h-3 w-3 shrink-0" />
          <span className="truncate font-mono text-[11px]">{selected}</span>
          <ChevronDown className="text-muted-foreground h-3 w-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <div className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
            Run on branch
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {loading ? (
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading branches…
            </div>
          ) : ordered.length === 0 ? (
            <div className="text-muted-foreground px-3 py-2 text-xs italic">No branches found.</div>
          ) : (
            <ul className="flex flex-col">
              {ordered.map((b) => {
                const isSelected = b.name === selected;
                return (
                  <li key={b.name}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(b.name);
                        setOpen(false);
                      }}
                      className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
                    >
                      {isSelected ? (
                        <Check className="text-success h-3 w-3 shrink-0" />
                      ) : (
                        <span className="inline-block h-3 w-3 shrink-0" />
                      )}
                      <span className="flex-1 truncate font-mono">{b.name}</span>
                      {b.protected ? (
                        <Shield
                          className="text-muted-foreground h-3 w-3 shrink-0"
                          aria-label="protected"
                        />
                      ) : null}
                      {b.tag ? (
                        <Badge tone="muted" className="text-[9px]">
                          {b.tag}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LogTail({ log, expanded }: { log: string | null | undefined; expanded: boolean }) {
  if (!log || log.trim().length === 0) return null;
  // Cap to last ~24 lines for the collapsed view; expanded shows the full
  // tail the runner sent (already 8 KB capped server-side).
  const lines = log.split(/\r?\n/);
  const shown = expanded ? lines : lines.slice(-24);
  return (
    <details className="bg-muted/30 mt-3 rounded-md border" open={expanded}>
      <summary className="text-muted-foreground hover:bg-muted/50 cursor-pointer select-none px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide">
        <span className="inline-flex items-center gap-1.5">
          <Terminal className="h-3 w-3" />
          Logs (last {shown.length} line{shown.length === 1 ? "" : "s"})
        </span>
      </summary>
      <pre className="text-muted-foreground max-h-64 overflow-auto px-3 py-2 text-[10px] leading-snug">
        {shown.join("\n")}
      </pre>
    </details>
  );
}

/**
 * Live terminal — tails the dev server's stdout/stderr.
 *
 * Two sources, for resilience:
 *   1. SSE (`/api/dev-servers/:id/logs/stream`) — sub-second, full scrollback.
 *      The runner streams chunks into a Redis Stream; this route polls + emits.
 *   2. `fallbackLog` (the `last_log_tail` snapshot) — pushed via Supabase
 *      Realtime on every heartbeat (the same channel that flips the status
 *      badge, no refresh needed).
 *
 * We show the SSE text while it's actively delivering; if the SSE stream goes
 * quiet (any client-side stall), we fall back to the Realtime snapshot so the
 * terminal keeps updating without a page refresh.
 */
function LiveTerminal({
  sessionId,
  active,
  fallbackLog,
}: {
  sessionId: string;
  active: boolean;
  fallbackLog: string | null | undefined;
}) {
  const [sseText, setSseText] = React.useState("");
  const [, setTick] = React.useState(0);
  const preRef = React.useRef<HTMLPreElement | null>(null);
  const lastIdRef = React.useRef<string | null>(null);
  const lastSseAtRef = React.useRef<number>(0);

  React.useEffect(() => {
    if (!active) return;
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const qs = lastIdRef.current ? `?since=${encodeURIComponent(lastIdRef.current)}` : "";
      es = new EventSource(`/api/dev-servers/${sessionId}/logs/stream${qs}`);
      es.onmessage = (ev) => {
        if (ev.data === "[DONE]") {
          es?.close();
          return;
        }
        let parsed: { id?: string; c?: string; done?: boolean };
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (parsed.done) {
          es?.close();
          return;
        }
        if (typeof parsed.c === "string") {
          if (parsed.id) lastIdRef.current = parsed.id;
          lastSseAtRef.current = Date.now();
          setSseText((cur) => {
            const next = cur + parsed.c;
            // Cap scrollback to the last ~64 KB so a chatty server can't grow
            // the DOM node unbounded.
            return next.length > 64_000 ? next.slice(next.length - 64_000) : next;
          });
        }
      };
      es.onerror = () => {
        // The server closes the stream on terminal/timeout (handled via the
        // `done` message). A genuine network blip lands here — close + retry,
        // resuming from lastId. The Realtime fallback covers any gap meanwhile.
        es?.close();
        if (!cancelled) reconnectTimer = setTimeout(connect, 1500);
      };
    };
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [sessionId, active]);

  // Tick every 2s so the SSE-freshness check re-evaluates and we fall back to
  // the Realtime snapshot when the stream goes quiet.
  React.useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, [active]);

  const sseFresh = lastSseAtRef.current > 0 && Date.now() - lastSseAtRef.current < 4000;
  const display = sseFresh && sseText ? sseText : (fallbackLog ?? sseText ?? "");

  // Auto-scroll to the bottom as new output lands.
  React.useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [display]);

  return (
    <div className="mt-3 overflow-hidden rounded-md border bg-zinc-950">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
        <Terminal className="h-3 w-3" />
        Terminal
        <span
          className={`ml-auto inline-flex items-center gap-1 ${sseFresh ? "text-success" : "text-zinc-500"}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${sseFresh ? "bg-success animate-pulse" : "bg-zinc-500"}`}
          />
          {sseFresh ? "live" : "syncing"}
        </span>
      </div>
      <pre
        ref={preRef}
        className="max-h-72 min-h-[3rem] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[10px] leading-snug text-zinc-300"
      >
        {display || "Waiting for output…"}
      </pre>
    </div>
  );
}

/**
 * Inline masked-input form shown when the runner parks a start with
 * `needs_env` — the workspace's `.env.example` lists keys not present in the
 * project's secrets vault. Saves each to the vault (reusing
 * `setProjectSecretAction`, the same path the board SecretRequestCard uses)
 * then re-triggers the run.
 */
function NeedsEnvForm({
  projectId,
  keys,
  busy,
  onDone,
}: {
  projectId: string;
  keys: string[];
  busy: boolean;
  /** Called after secrets are saved. `skipEnvCheck=true` starts the dev server
   *  even if required vars are still missing ("Skip & start anyway"). */
  onDone: (skipEnvCheck: boolean) => void;
}) {
  // Keys are encoded by the runner: "KEY" = required, "KEY?" = optional (the
  // var is marked `optional` in .env.example). Required keys gate the start;
  // optional ones can be left blank to skip.
  const fields = React.useMemo(
    () =>
      keys.map((k) =>
        k.endsWith("?") ? { key: k.slice(0, -1), required: false } : { key: k, required: true },
      ),
    [keys],
  );
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const requiredCount = fields.filter((f) => f.required).length;
  const optionalCount = fields.length - requiredCount;
  const allRequiredFilled = fields.every(
    (f) => !f.required || (values[f.key] ?? "").trim().length > 0,
  );

  // Save whatever's filled, then start. `skip=true` ("Skip & start anyway")
  // bypasses the required-env gate so the dev server spawns even with required
  // vars still missing; `skip=false` ("Save & start") requires them filled.
  async function submit(skip: boolean) {
    setSaving(true);
    try {
      for (const f of fields) {
        const val = (values[f.key] ?? "").trim();
        if (val.length === 0) {
          if (f.required && !skip) {
            toast.error(`${f.key} is required`);
            return;
          }
          continue; // blank → don't save
        }
        const res = await setProjectSecretAction({
          projectId,
          secretKey: f.key,
          value: val,
        });
        if (!res.ok) {
          toast.error(`Couldn't save ${f.key}`, { description: res.error });
          return;
        }
      }
      toast.success(skip ? "Starting…" : "Saved env vars", {
        description: skip
          ? "Starting without the missing vars — watch the terminal for errors."
          : "Restarting the dev server…",
      });
      onDone(skip);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (allRequiredFilled) void submit(false);
      }}
      className="flex flex-col gap-2"
    >
      <div className="text-warning flex items-start gap-2 text-xs">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {requiredCount} required
          {optionalCount > 0 ? ` + ${optionalCount} optional` : ""} environment variable
          {fields.length === 1 ? "" : "s"} missing (from{" "}
          <code className="font-mono">.env.example</code>).{" "}
          {requiredCount > 0
            ? `Fill the required one${requiredCount === 1 ? "" : "s"} to start`
            : "Provide them"}
          {optionalCount > 0 ? "; optional ones can be left blank to skip" : ""}. Values are stored
          encrypted in the project secrets vault.
        </span>
      </div>
      {fields.map((f) => (
        <div key={f.key} className="flex items-center gap-2">
          <div className="flex w-48 shrink-0 items-center gap-1.5">
            <code className="text-muted-foreground truncate font-mono text-[11px]">{f.key}</code>
            {!f.required ? (
              <Badge tone="muted" className="px-1 py-0 text-[9px]">
                optional
              </Badge>
            ) : null}
          </div>
          <Input
            type="password"
            autoComplete="off"
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            placeholder={f.required ? "value" : "leave blank to skip"}
            className="font-mono text-xs"
            disabled={saving || busy}
          />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="primary"
          disabled={!allRequiredFilled || saving || busy}
          onClick={() => void submit(false)}
          className="gap-2"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Save &amp; start
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving || busy}
          onClick={() => void submit(true)}
          className="gap-1.5"
          title="Start the dev server without the missing vars (the app may error if it truly needs one)"
        >
          Skip &amp; start anyway
        </Button>
      </div>
    </form>
  );
}

export function RunPanel({
  tenantId,
  projectId,
  scope = { kind: "project" },
  ticketId,
  pendingPushId,
  defaultBranch,
  integrationBranch,
  scopeBranch,
}: {
  tenantId: string;
  projectId: string;
  // Discriminator only; the projectId / pendingPushId props carry the actual
  // scope target. Default is "project" — the /projects page.
  scope?: { kind: "project" } | { kind: "pending_push" };
  ticketId?: string;
  pendingPushId?: string;
  /** Optional project metadata used by the branch picker so the dropdown
   *  can pin production + integration branches at the top. When omitted
   *  the picker falls back to "main" + null. */
  defaultBranch?: string;
  integrationBranch?: string | null;
  /** WI-10 — the branch this scope is pinned to: the pending push's feature
   *  branch. It is what a run serves unless the operator picks otherwise, and
   *  it's pinned at the top of both pickers so they can always get back to it
   *  (it may not exist on origin yet, so the GitHub branch list won't have it).
   *  Omitted for a project scope, whose default is integration ?? default. */
  scopeBranch?: string;
}) {
  // 2026-06-08 hotfix — router.refresh() on action callbacks so the panel
  // re-fetches server-rendered state instead of waiting on realtime to
  // catch up. Realtime is best-effort; this is the deterministic fallback.
  const router = useRouter();

  // Compose the realtime scope object the hook expects. We do this on every
  // render but `useLiveDevServer` keys its effect on a scopeKey primitive,
  // so this isn't a hidden re-subscribe per render.
  const hookScope: DevServerScope = React.useMemo(() => {
    if (scope.kind === "pending_push") {
      if (!pendingPushId) {
        // Defensive — caller misused the component. We still fall through to
        // a project-scoped lookup so the page doesn't crash entirely; the
        // log line surfaces the mistake.
        console.warn(
          "[RunPanel] scope=pending_push requires pendingPushId; falling back to project scope.",
        );
        return { kind: "project", projectId };
      }
      return { kind: "pending_push", pendingPushId };
    }
    return { kind: "project", projectId };
  }, [scope.kind, projectId, pendingPushId]);

  const { session, isLive, loading } = useLiveDevServer({
    tenantId,
    scope: hookScope,
  });
  const [commandOverride, setCommandOverride] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // WI-9/WI-10 — operator's branch pick for the idle-state "Run on branch"
  // picker. `null` = "no explicit pick yet", falling back to the scope's own
  // branch: the pending push's feature branch, or integration ?? default for a
  // project run. A pending-push mount that doesn't pass `scopeBranch` leaves
  // this null, and `onStart` then sends no branch at all — the server keeps
  // serving the pending push's own branch, which is the pre-WI-10 behaviour.
  const [selectedBranch, setSelectedBranch] = React.useState<string | null>(null);
  const scopeFallbackBranch =
    scope.kind === "pending_push"
      ? (scopeBranch ?? null)
      : (integrationBranch ?? defaultBranch ?? "main");
  const branchToRun = selectedBranch ?? scopeFallbackBranch;

  // ── Idle-reaper deferral ──────────────────────────────────────────────
  // While we have an active session, ping the server every 60s so the
  // 30-minute idle reaper doesn't stop a panel the operator is actively
  // looking at. The hook unmount tears the timer down via the effect's
  // return.
  React.useEffect(() => {
    if (!session) return;
    if (
      session.status !== "starting" &&
      session.status !== "running" &&
      session.status !== "building"
    )
      return;
    const id = session.id;
    const timer = setInterval(() => {
      void pingDevServerInteractionAction({ sessionId: id });
    }, 60_000);
    // Send one immediately so the bump happens at panel open, not 60s later.
    void pingDevServerInteractionAction({ sessionId: id });
    return () => clearInterval(timer);
  }, [session]);

  // opts is optional; bound directly to some onClick handlers (which pass a
  // MouseEvent) — an object param keeps `opts?.skipEnvCheck` safely undefined there.
  async function onStart(opts?: { skipEnvCheck?: boolean }) {
    setBusy(true);
    const trimmed = commandOverride.trim();
    const res = await startDevServerForProjectAction({
      projectId,
      ticketId,
      pendingPushId,
      commandOverride: trimmed.length > 0 ? trimmed : undefined,
      skipEnvCheck: opts?.skipEnvCheck === true,
      // WI-10 — every scope now honours an explicit branch. Undefined means "no
      // pick": the server serves the scope's own branch (see
      // startDevServerForProjectAction). For a pending push, a pick other than
      // its feature branch is checked out in the change's workspace — safely,
      // with an auto-stash and no force.
      branch: branchToRun ?? undefined,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error("Couldn't start dev server", { description: res.error });
      return;
    }
    toast.success("Starting dev server", {
      description: "Probing port and spawning…",
    });
    // Clear the override so the next click picks up the live state. The
    // realtime hook will flip to a Starting session shortly.
    setCommandOverride("");
    router.refresh();
  }

  async function onStop() {
    if (!session) return;
    setBusy(true);
    const res = await stopDevServerAction({ sessionId: session.id });
    setBusy(false);
    if (!res.ok) {
      toast.error("Couldn't stop dev server", { description: res.error });
      return;
    }
    toast.success("Stopping dev server", {
      description: "Waiting for the runner to confirm…",
    });
    router.refresh();
  }

  async function onCopyUrl() {
    if (!session?.url) return;
    try {
      await navigator.clipboard.writeText(session.url);
      toast.success("Copied URL", { description: session.url });
    } catch (err) {
      toast.error("Copy failed", { description: (err as Error).message });
    }
  }

  function onOpenUrl() {
    if (!session?.url) return;
    window.open(session.url, "_blank", "noopener,noreferrer");
  }

  // Slice C — Open the workspace folder in VS Code via the protocol handler.
  // We resolve the URL through a server action (auth-gated) so the
  // absolute path never lands in the rendered DOM. On success the action
  // returns a one-shot `vscode://file/<abs-path>` URL we navigate to.
  async function onOpenInVscode() {
    if (!session) return;
    const res = await getVscodeOpenUrlAction({
      kind: "dev_server",
      sessionId: session.id,
    });
    if (!res.ok) {
      toast.error("Couldn't open in VS Code", { description: res.error });
      return;
    }
    window.location.href = res.value.url;
  }

  // ── Render branches ──────────────────────────────────────────────────
  // We deliberately render every branch through the same outer shell so
  // the panel's layout doesn't reflow on status flips.
  const isIdle =
    !session ||
    (session.status !== "starting" &&
      session.status !== "running" &&
      session.status !== "errored" &&
      session.status !== "building" &&
      session.status !== "needs_env");
  const isStarting = session?.status === "starting";
  const isRunning = session?.status === "running";
  const isErrored = session?.status === "errored";
  const isBuilding = session?.status === "building";
  const isNeedsEnv = session?.status === "needs_env";

  return (
    <div className="bg-card rounded-md border p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
            Dev server
          </span>
          {loading ? (
            <Badge tone="muted" className="text-[10px]">
              Loading…
            </Badge>
          ) : isStarting ? (
            <Badge tone="info" className="gap-1 text-[10px]">
              <StatusDot tone="warning" pulse title="Starting" />
              Starting
            </Badge>
          ) : isBuilding ? (
            <Badge tone="info" className="gap-1 text-[10px]">
              <StatusDot tone="warning" pulse title="Building" />
              Building
            </Badge>
          ) : isNeedsEnv ? (
            <Badge tone="warn" className="gap-1 text-[10px]">
              <StatusDot tone="warning" pulse={false} title="Needs env" />
              Needs env
            </Badge>
          ) : isRunning ? (
            <Badge tone="ok" className="gap-1 text-[10px]">
              <StatusDot tone="success" pulse title="Running" />
              Running
            </Badge>
          ) : isErrored ? (
            <Badge tone="danger" className="gap-1 text-[10px]">
              <StatusDot tone="destructive" pulse={false} title="Errored" />
              Errored
            </Badge>
          ) : (
            <Badge tone="muted" className="gap-1 text-[10px]">
              <StatusDot tone="muted" pulse={false} title="Idle" />
              Idle
            </Badge>
          )}
        </div>
        {session ? (
          <span
            className="text-muted-foreground text-[10px]"
            title={isLive ? "Realtime connected" : "Realtime reconnecting"}
          >
            {isLive ? "live" : "offline"}
          </span>
        ) : null}
      </div>

      {/* ── Idle ───────────────────────────────────────────────────────── */}
      {isIdle ? (
        <div className="flex flex-col gap-2">
          {/* WI-9/WI-10 — pick a branch before Run so the session lands directly
              on uat/test/dev instead of starting on the scope's own branch and
              needing a switch after. A pending-push scope defaults to the
              change's feature branch and can preview any other branch in the
              same workspace. `branchToRun` is null only when a pending-push
              mount didn't pass `scopeBranch` — nothing to select against, so we
              render no picker and the run stays on the change's branch. */}
          {branchToRun ? (
            <div className="flex items-center gap-2">
              <IdleBranchPicker
                projectId={projectId}
                defaultBranch={defaultBranch ?? "main"}
                integrationBranch={integrationBranch ?? null}
                scopeBranch={scopeBranch ?? null}
                selected={branchToRun}
                onSelect={setSelectedBranch}
                disabled={busy}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={commandOverride}
              onChange={(e) => setCommandOverride(e.target.value)}
              placeholder="Override command (optional, e.g. pnpm dev)"
              className="font-mono text-xs"
              aria-label="Dev server command override"
              disabled={busy}
            />
            <Button
              variant="primary"
              onClick={() => onStart()}
              disabled={busy}
              className="gap-2 sm:shrink-0"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Run on localhost
            </Button>
          </div>
        </div>
      ) : null}

      {/* ── Starting ──────────────────────────────────────────────────── */}
      {isStarting && session ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>
                {session.statusReason ? `${session.statusReason}…` : "Probing port and spawning…"}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              disabled={busy}
              className="gap-1.5"
            >
              <StopCircle className="h-3.5 w-3.5" />
              Stop
            </Button>
          </div>
          <code className="bg-muted/50 text-muted-foreground rounded px-2 py-1 font-mono text-[10px]">
            {session.command}
          </code>
          <LiveTerminal sessionId={session.id} active fallbackLog={session.lastLogTail} />
        </div>
      ) : null}

      {/* ── Building ──────────────────────────────────────────────────── */}
      {isBuilding && session ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Building the project…</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              disabled={busy}
              className="gap-1.5"
            >
              <StopCircle className="h-3.5 w-3.5" />
              Stop
            </Button>
          </div>
          <code className="bg-muted/50 text-muted-foreground rounded px-2 py-1 font-mono text-[10px]">
            {session.command}
          </code>
          <LiveTerminal sessionId={session.id} active fallbackLog={session.lastLogTail} />
        </div>
      ) : null}

      {/* ── Needs env ─────────────────────────────────────────────────── */}
      {isNeedsEnv && session ? (
        <NeedsEnvForm
          projectId={projectId}
          keys={session.missingEnvKeys ?? []}
          busy={busy}
          onDone={(skip) => onStart({ skipEnvCheck: skip })}
        />
      ) : null}

      {/* ── Running ───────────────────────────────────────────────────── */}
      {isRunning && session ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BranchPicker
              sessionId={session.id}
              currentBranch={session.branch ?? "(unknown)"}
              projectId={projectId}
              defaultBranch={defaultBranch ?? "main"}
              integrationBranch={integrationBranch ?? null}
              scopeBranch={scopeBranch ?? null}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a
              href={session.url ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground truncate font-mono text-xs hover:underline hover:underline-offset-2"
            >
              {session.url ?? "(no url yet)"}
            </a>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={onCopyUrl}
                disabled={!session.url}
                className="gap-1.5"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenUrl}
                disabled={!session.url}
                className="gap-1.5"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenInVscode}
                className="gap-1.5"
                title="Open workspace in VS Code"
              >
                <Code2 className="h-3.5 w-3.5" />
                VS Code
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onStop}
                disabled={busy}
                className="gap-1.5"
              >
                <StopCircle className="h-3.5 w-3.5" />
                Stop
              </Button>
            </div>
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
            <code className="bg-muted/50 rounded px-1.5 py-0.5 font-mono">{session.command}</code>
            <span>·</span>
            <span>started {new Date(session.startedAt).toLocaleTimeString()}</span>
            {session.port ? (
              <>
                <span>·</span>
                <span>port {session.port}</span>
              </>
            ) : null}
            {/* Slice C — workspace dirty pill. Surfaces operator's local
                edits so they know `git stash apply` may be needed if they
                navigate away before committing. */}
            {session.workspaceDirtyFileCount && session.workspaceDirtyFileCount > 0 ? (
              <>
                <span>·</span>
                <Badge tone="warn" className="text-[10px]">
                  {session.workspaceDirtyFileCount} uncommitted edit
                  {session.workspaceDirtyFileCount === 1 ? "" : "s"}
                </Badge>
              </>
            ) : null}
          </div>
          <LiveTerminal sessionId={session.id} active fallbackLog={session.lastLogTail} />
        </div>
      ) : null}

      {/* ── Errored ───────────────────────────────────────────────────── */}
      {isErrored && session ? (
        <div className="flex flex-col gap-2">
          {/* 2026-06-08 hotfix — also render the BranchPicker in the
              errored state so the operator can recover by switching to a
              different branch without going through Stop → Start.
              Without this, a failed switch leaves them stuck on the bad
              branch with no way to pick a recovery target. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BranchPicker
              sessionId={session.id}
              currentBranch={session.branch ?? "(unknown)"}
              projectId={projectId}
              defaultBranch={defaultBranch ?? "main"}
              integrationBranch={integrationBranch ?? null}
              scopeBranch={scopeBranch ?? null}
            />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="text-destructive flex min-w-0 items-start gap-2 text-xs">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="break-words">
                {session.statusReason ?? "Dev server exited with an error."}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onStart()}
              disabled={busy}
              className="gap-1.5"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Restart
            </Button>
          </div>
          <LogTail log={session.lastLogTail} expanded />
        </div>
      ) : null}
    </div>
  );
}
