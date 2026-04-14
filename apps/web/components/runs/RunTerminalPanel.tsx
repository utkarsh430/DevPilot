"use client";

// In-browser terminal panel that attaches to a running agent's tmux pane via
// the /api/runs/[id]/attach SSE+POST bridge. Rendered inside RunInspector
// when the run is local-cc and has a tmux_session_name (Track 2 stamps this).
//
// Two views over the SAME SSE byte stream:
//   • "Readable" (default) - the pane is running a headless `claude -p
//     --output-format=stream-json`, so the bytes are (mostly) one JSON event
//     per line. We buffer them into complete lines, translate each into a
//     human-readable feed item (agent prose, "→ Tool: summary", "✓/✗ result",
//     subtle status), and render an auto-scrolling live feed. Non-JSON lines
//     fall through as raw text - nothing is dropped or allowed to crash the
//     feed. The pure translation lives in lib/runs/terminal-feed.ts (unit
//     tested; the .tsx can't load under Vitest).
//   • "Raw" - the original xterm.js pane, byte-for-byte, for power users /
//     debugging. Full read-write terminal input (Ctrl-C, arrows, paste).
//
// Read-write ("take the wheel") is preserved in BOTH views: xterm forwards
// keystrokes in Raw mode; Readable mode offers a one-line input that POSTs the
// same { kind:"input" } control frame to the agent's pane.
//
// Wire shape (matches /api/runs/[id]/attach/route.ts):
//   • EventSource GET ?cols=&rows=
//       - default event: `data: {"c": "..."}` - bytes to write into xterm
//       - meta event: `event: meta\ndata: {"kind":"open"|"timeout"|"exit",...}`
//       - SSE comment lines `: keepalive ...` keep the connection warm
//   • POST { kind: "input", data }    - pty stdin
//   • POST { kind: "resize", cols, rows } - pty resize (driven by FitAddon)
//   • POST { kind: "close" }          - clean shutdown (called on unmount)
//
// xterm.js is dynamically imported on mount so we don't pull the CSS / DOM-
// heavy module into the server bundle. The first frame replays scrollback
// (capped at ~64KB) so the operator sees recent context, then live data
// streams in - into both the xterm pane and the readable feed.

import * as React from "react";
import {
  AlertTriangle,
  ChevronRight,
  CornerDownLeft,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  createTerminalFeedBuffer,
  type FeedItem,
  type TerminalFeedBuffer,
} from "@/lib/runs/terminal-feed";

type MetaEvent =
  | { kind: "open"; sessionName: string }
  | { kind: "timeout" }
  | { kind: "exit"; code?: number; signal?: number };

// Keep the readable feed bounded so a long-running agent can't grow the DOM /
// memory without limit. We keep the newest slice - the live tail is what
// matters; older context stays in Raw mode's xterm scrollback (5000 lines).
const MAX_FEED_ITEMS = 3000;

type View = "readable" | "raw";

export function RunTerminalPanel({
  runId,
  sessionName,
  onClose,
  className,
}: {
  runId: string;
  /** Display only - the server resolves the real session name from runs.tmux_session_name. */
  sessionName: string;
  /** Optional close affordance - wires to the host's collapsed state. */
  onClose?: () => void;
  className?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const termRef = React.useRef<{
    term: import("@xterm/xterm").Terminal | null;
    fit: import("@xterm/addon-fit").FitAddon | null;
    es: EventSource | null;
    ro: ResizeObserver | null;
    disposed: boolean;
    feed: TerminalFeedBuffer;
    sendResize: (() => void) | null;
  }>({
    term: null,
    fit: null,
    es: null,
    ro: null,
    disposed: false,
    feed: createTerminalFeedBuffer(),
    sendResize: null,
  });
  const [view, setView] = React.useState<View>("readable");
  const [status, setStatus] = React.useState<
    "loading" | "connecting" | "connected" | "exited" | "error"
  >("loading");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<FeedItem[]>([]);
  const [bytes, setBytes] = React.useState(0);

  const appendItems = React.useCallback((next: FeedItem[]) => {
    if (next.length === 0) return;
    setItems((prev) => {
      const merged = prev.concat(next);
      return merged.length > MAX_FEED_ITEMS ? merged.slice(-MAX_FEED_ITEMS) : merged;
    });
  }, []);

  const postInput = React.useCallback(
    (data: string) => {
      void fetch(`/api/runs/${runId}/attach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "input", data }),
      }).catch(() => undefined);
    },
    [runId],
  );

  React.useEffect(() => {
    const state = termRef.current;
    let cancelled = false;

    (async () => {
      // Dynamic import so xterm doesn't get into the SSR bundle.
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      // CSS lives alongside the package - import once per mount; xterm CSS
      // is idempotent.
      await import("@xterm/xterm/css/xterm.css");

      if (cancelled || !containerRef.current) return;

      const term = new Terminal({
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 5000,
        // Match the surrounding dark/light theme through opacity-friendly
        // values rather than hard-coding hex; tweak later if needed.
        theme: {
          background: "#0b0d12",
          foreground: "#e6e7ea",
          cursor: "#e6e7ea",
          selectionBackground: "#3a3f4a",
        },
        // Keep input local-echo OFF - the remote pty echoes for us.
        convertEol: false,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      const links = new WebLinksAddon();
      term.loadAddon(fit);
      term.loadAddon(links);
      term.open(containerRef.current);
      // First fit before we measure cols/rows for the EventSource.
      try {
        fit.fit();
      } catch {
        // Container may not be measured yet - proceed with defaults.
      }
      state.term = term;
      state.fit = fit;

      // Wire stdin: every key/paste/etc. into xterm becomes a POST. Only active
      // in Raw mode (xterm is hidden otherwise); Readable mode has its own
      // input row.
      term.onData((data) => {
        if (state.disposed) return;
        postInput(data);
      });

      // Resize: fire on ResizeObserver via FitAddon's measurement, then POST.
      const sendResize = () => {
        if (state.disposed || !state.fit || !state.term) return;
        try {
          state.fit.fit();
        } catch {
          return;
        }
        const cols = state.term.cols;
        const rows = state.term.rows;
        void fetch(`/api/runs/${runId}/attach`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "resize", cols, rows }),
        }).catch(() => undefined);
      };
      state.sendResize = sendResize;
      // Initial resize + observe container size for future changes. Stashed
      // on `state` so the outer effect's cleanup can disconnect it.
      const ro = new ResizeObserver(() => sendResize());
      ro.observe(containerRef.current);
      state.ro = ro;

      // Open SSE for output AFTER xterm is mounted so the first replayed
      // scrollback paints into a real terminal, not a phantom one.
      setStatus("connecting");
      const initialCols = term.cols || 120;
      const initialRows = term.rows || 32;
      const es = new EventSource(
        `/api/runs/${runId}/attach?cols=${initialCols}&rows=${initialRows}`,
      );
      state.es = es;

      es.onopen = () => {
        if (state.disposed) return;
        setStatus("connected");
        setErrorMsg(null);
      };
      es.onerror = () => {
        // EventSource auto-reconnects; surface a transient error banner if
        // the readyState is closed (irrecoverable).
        if (state.disposed) return;
        if (es.readyState === EventSource.CLOSED) {
          setStatus("error");
          setErrorMsg("Stream closed - reopen the terminal to reconnect.");
        }
      };
      es.onmessage = (ev) => {
        if (state.disposed || !state.term) return;
        try {
          const { c } = JSON.parse(ev.data) as { c?: string };
          if (typeof c === "string" && c.length > 0) {
            // Raw pane: byte-for-byte (xterm buffers even while hidden).
            state.term.write(c);
            // Readable feed: the same bytes, translated once complete lines
            // are available.
            appendItems(state.feed.push(c));
            setBytes((b) => b + c.length);
          }
        } catch {
          // ignore malformed frames
        }
      };
      // Meta events arrive on a named SSE event channel.
      es.addEventListener("meta", (ev: MessageEvent) => {
        if (state.disposed) return;
        try {
          const m = JSON.parse(ev.data) as MetaEvent;
          if (m.kind === "exit") {
            setStatus("exited");
            appendItems(state.feed.flush());
          } else if (m.kind === "timeout") {
            setStatus("exited");
            appendItems(state.feed.flush());
            setErrorMsg("Stream timed out (30 minute cap). Reopen to reconnect.");
          }
        } catch {
          // ignore malformed meta
        }
      });
    })().catch((err) => {
      if (cancelled) return;
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
      // `state` is the same stable ref object captured at the top of this
      // effect - reuse it so the cleanup doesn't re-read termRef.current.
      const s = state;
      s.disposed = true;
      try {
        s.ro?.disconnect();
      } catch {
        // ignore
      }
      try {
        s.es?.close();
      } catch {
        // ignore
      }
      // Tell the server to close the underlying pty when the LAST viewer
      // leaves - the server-side registry idle-reaps anyway, but a clean
      // close keeps the system tidy and frees the tmux attach immediately.
      // We don't await; the request is best-effort.
      void fetch(`/api/runs/${runId}/attach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "close" }),
      }).catch(() => undefined);
      try {
        s.term?.dispose();
      } catch {
        // ignore
      }
      s.term = null;
      s.fit = null;
      s.es = null;
      s.ro = null;
      s.sendResize = null;
    };
  }, [runId, appendItems, postInput]);

  // xterm can't measure while hidden, so re-fit when Raw becomes visible.
  React.useEffect(() => {
    if (view !== "raw") return;
    const id = requestAnimationFrame(() => {
      termRef.current.sendResize?.();
      // Repaint the buffered scrollback that accumulated while hidden, then
      // land on the live tail.
      termRef.current.term?.scrollToBottom();
      termRef.current.term?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [view]);

  const statusLabel: Record<typeof status, string> = {
    loading: "loading…",
    connecting: "connecting…",
    connected: "live",
    exited: "session ended",
    error: "error",
  };
  const statusTone: Record<typeof status, string> = {
    loading: "text-muted-foreground",
    connecting: "text-muted-foreground",
    connected: "text-success",
    exited: "text-muted-foreground",
    error: "text-destructive",
  };

  return (
    <div className={cn("bg-background overflow-hidden rounded-lg border", className)}>
      <div className="bg-muted/40 flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <TerminalIcon className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono" title={sessionName}>
            {sessionName}
          </span>
          <span className={cn("font-medium", statusTone[status])}>· {statusLabel[status]}</span>
          <span className="text-muted-foreground hidden font-mono text-[10px] sm:inline">
            · {bytes.toLocaleString()}B
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* View toggle - Readable (default) vs Raw xterm pane. */}
          <div className="bg-muted/60 flex items-center rounded-md p-0.5">
            <button
              type="button"
              onClick={() => setView("readable")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                view === "readable"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={view === "readable"}
            >
              Readable
            </button>
            <button
              type="button"
              onClick={() => setView("raw")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                view === "raw"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={view === "raw"}
            >
              Raw
            </button>
          </div>
          {onClose ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Close terminal"
              className="h-7 w-7 p-0"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      {errorMsg ? (
        <div className="bg-destructive/10 text-destructive flex items-center gap-2 border-b px-3 py-1.5 text-xs">
          <AlertTriangle className="h-3.5 w-3.5" />
          {errorMsg}
        </div>
      ) : null}

      {/* Readable feed. Hidden (not unmounted) in Raw mode so the SSE effect's
          single xterm/EventSource wiring is never torn down on a view switch. */}
      <div className={cn(view !== "readable" && "hidden")}>
        <ReadableFeed items={items} status={status} onSubmitInput={postInput} />
      </div>

      {/* Raw xterm viewport. xterm.js measures this container via FitAddon -
          keep an explicit min height so it never collapses. Always mounted; the
          container just hides in Readable mode. */}
      <div
        ref={containerRef}
        className={cn("h-[420px] w-full", view !== "raw" && "hidden")}
        style={{ background: "#0b0d12" }}
      />
    </div>
  );
}

function ReadableFeed({
  items,
  status,
  onSubmitInput,
}: {
  items: FeedItem[];
  status: string;
  onSubmitInput: (data: string) => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stickRef = React.useRef(true);
  const [draft, setDraft] = React.useState("");

  // Auto-scroll to the newest item unless the operator has scrolled up.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Treat "within 40px of the bottom" as stuck, so the last partial line
    // doesn't unstick the view.
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    // Enter on a pty is a carriage return; append it so the line is committed
    // to the agent's shell/prompt.
    onSubmitInput(draft + "\r");
    setDraft("");
    stickRef.current = true;
  };

  return (
    <div className="flex h-[420px] flex-col" style={{ background: "#0b0d12" }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed"
      >
        {items.length === 0 ? (
          <p className="text-muted-foreground/70 py-6 text-center text-xs">
            {status === "connected" || status === "exited"
              ? "Waiting for the agent to produce output…"
              : "Connecting to the live session…"}
          </p>
        ) : (
          <ul className="space-y-1">
            {items.map((it) => (
              <FeedRow key={it.id} item={it} />
            ))}
          </ul>
        )}
      </div>
      {/* Readable-mode input - same { kind:"input" } wire as xterm keystrokes,
          so "take the wheel" works here too. */}
      <form
        onSubmit={submit}
        className="flex items-center gap-2 border-t border-white/10 px-2 py-1.5"
      >
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/40" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type to the agent's terminal, press Enter to send…"
          className="flex-1 bg-transparent font-mono text-[12.5px] text-[#e6e7ea] placeholder:text-white/30 focus:outline-none"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={!draft}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-white/50 hover:text-white/80 disabled:opacity-40"
          aria-label="Send input to the agent"
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const [expanded, setExpanded] = React.useState(false);

  if (item.kind === "assistant") {
    return (
      <li className="text-[#e6e7ea]">
        <span className="whitespace-pre-wrap break-words">{item.text}</span>
      </li>
    );
  }

  if (item.kind === "tool_call") {
    return (
      <li className="text-[#8ab4f8]">
        <span className="text-[#8ab4f8]/70">→ </span>
        <span className="font-semibold">{item.tool}</span>
        <span className="text-[#e6e7ea]/80">: </span>
        <span className="break-words text-[#e6e7ea]/80">{item.text}</span>
        {item.truncated && item.detail ? (
          <ExpandToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        ) : null}
        {expanded && item.detail ? <DetailBlock text={item.detail} /> : null}
      </li>
    );
  }

  if (item.kind === "tool_result") {
    const tone = item.isError ? "text-[#f28b82]" : "text-[#81c995]";
    return (
      <li className={tone}>
        <span>{item.isError ? "✗ " : "✓ "}</span>
        <span className="whitespace-pre-wrap break-words text-[#e6e7ea]/70">{item.text}</span>
        {item.truncated && item.detail ? (
          <ExpandToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        ) : null}
        {expanded && item.detail ? <DetailBlock text={item.detail} /> : null}
      </li>
    );
  }

  if (item.kind === "system") {
    return (
      <li className="text-white/40">
        <span className="break-words text-[11px]">· {item.text}</span>
        {item.truncated && item.detail ? (
          <ExpandToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        ) : null}
        {expanded && item.detail ? <DetailBlock text={item.detail} /> : null}
      </li>
    );
  }

  // raw - verbatim, dimmed so it reads as machine output, never dropped.
  return (
    <li className="text-white/55">
      <span className="whitespace-pre-wrap break-words">{item.text}</span>
    </li>
  );
}

function ExpandToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="ml-1 rounded px-1 text-[10px] text-white/40 hover:text-white/70"
    >
      {expanded ? "less" : "more"}
    </button>
  );
}

function DetailBlock({ text }: { text: string }) {
  return (
    <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-black/40 px-2 py-1 text-[11px] text-white/60">
      {text}
    </pre>
  );
}
