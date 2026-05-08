"use client";

// Phase 1 / M14 — embeddable widget client.
//
// Reads `?token=` from the URL, posts the user's prompt to
// `/api/widget/run`, and renders the SSE-streamed response. Deliberately
// minimal: a single chat box, no history persistence (the run row IS the
// history — operators can replay it from the Run Inspector).

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; runId?: string; status?: string };

export function WidgetClient({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [token, setToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token"));
  }, []);

  async function send() {
    if (!input.trim() || !token) return;
    const userMsg: Message = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setBusy(true);
    setError(null);

    const assistantIdx = messages.length + 1;
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch(`/api/widget/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentId, prompt: userMsg.content, stream: true }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`request failed: ${res.status} ${detail}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE framing — split on \n\n.
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const payload = dataLine.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const ev = JSON.parse(payload);
            if (ev?.kind === "think" && ev.payload?.text) {
              setMessages((prev) => {
                const copy = [...prev];
                if (copy[assistantIdx]) {
                  copy[assistantIdx] = {
                    role: "assistant",
                    content: ev.payload.text,
                    runId: ev.runId,
                  };
                }
                return copy;
              });
            }
            if (ev?.status === "done" || ev?.status === "failed") {
              setMessages((prev) => {
                const copy = [...prev];
                const cur = copy[assistantIdx];
                if (cur && cur.role === "assistant") {
                  copy[assistantIdx] = { ...cur, status: ev.status, runId: ev.runId };
                }
                return copy;
              });
            }
          } catch {
            // ignore malformed frames
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center p-4 text-sm">
        Add <code>?token=&lt;widget-token&gt;</code> to the URL to enable this widget.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-muted-foreground text-sm">Ask {agentName} anything to get started.</p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`mb-3 ${m.role === "user" ? "text-right" : "text-left"}`}>
              <div
                className={`inline-block max-w-[85%] rounded-md px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`}
              >
                {m.content || (m.role === "assistant" ? "…" : "")}
              </div>
            </div>
          ))
        )}
      </div>
      {error ? (
        <p className="text-destructive px-4 pb-2 text-xs" role="alert">
          {error}
        </p>
      ) : null}
      <div className="border-border flex gap-2 border-t p-3">
        <Textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={busy}
        />
        <Button onClick={send} disabled={busy || !input.trim()} variant="primary">
          {busy ? "…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
