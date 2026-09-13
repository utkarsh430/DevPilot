"use client";

// Phase 2 / M5e — Log tail view, used by the RunPanel (B3) on both the
// project detail page and the /changes/[id] page.
//
// Wrapping the log block in a native `<details>` keeps the surface area
// tiny: no extra Radix collapsible, no keyboard-trap surprises, and the
// "open by default if there's a relevant tail" decision is the caller's,
// not ours. The Copy button uses navigator.clipboard with a sonner toast
// so the operator gets explicit feedback (silent copy is one of the most
// common UX papercuts).

import * as React from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";

export function LogTail({
  logs,
  defaultOpen = false,
  maxLines = 24,
  label = "Logs",
}: {
  logs: string | null;
  defaultOpen?: boolean;
  maxLines?: number;
  /** Override the summary label, e.g. "Server logs" or "Stderr". */
  label?: string;
}) {
  const trimmed = React.useMemo(() => {
    if (!logs) return "";
    const all = logs.split("\n");
    if (all.length <= maxLines) return logs;
    return all.slice(all.length - maxLines).join("\n");
  }, [logs, maxLines]);

  const hasLogs = trimmed.trim().length > 0;

  async function copy() {
    if (!logs) return;
    try {
      await navigator.clipboard.writeText(logs);
      toast.success("Copied logs");
    } catch {
      toast.error("Copy failed — clipboard blocked");
    }
  }

  return (
    <details className="bg-muted/20 group rounded-md border text-xs" open={defaultOpen}>
      <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-1.5 text-[11px] font-medium">
        <span>
          {label}
          {hasLogs ? (
            <span className="text-muted-foreground ml-1">(last {maxLines} lines)</span>
          ) : null}
        </span>
      </summary>
      {hasLogs ? (
        <div className="bg-background/60 border-t">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[10px] leading-snug">
            {trimmed}
          </pre>
          <div className="flex items-center justify-end gap-2 border-t px-2 py-1.5">
            <Button variant="ghost" size="xs" type="button" onClick={copy} disabled={!logs}>
              <Copy className="h-3 w-3" />
              Copy
            </Button>
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground border-t px-3 py-2 text-[10px]">
          No log output yet.
        </div>
      )}
    </details>
  );
}
