"use client";

// Download the per-ticket audit PDF, and surface a failure AS a failure.
//
// This used to be a plain `<a href="/api/board/tickets/:id/export" download>`,
// which is only correct while the route cannot fail. It can: the aggregator
// FAILS LOUD on land-state / verification reads, and any render error lands in
// the same catch — all of which return `{"error":"export failed"}` with status
// 500. A `download` anchor does not care about the status code. The browser
// simply saved the JSON error body under the .pdf filename, so the operator got
// a corrupt "PDF" and no indication anything had gone wrong. The failure was
// indistinguishable from a successful download until they opened the file.
//
// So the click goes through `fetch`, which lets us READ the status before
// committing to a download, and failures become a toast — the same way the
// project export already reports them. Fetch + blob does buffer the PDF in JS
// memory, unlike the project export's navigate-to-signed-URL; that is an
// accepted trade here because a single ticket's PDF is small and this is the
// only way to inspect the response before saving it.

import * as React from "react";
import { toast } from "@/components/ui/sonner";

export type TicketExportState = "idle" | "working";

export function useTicketExport(ticketId: string | null) {
  const [state, setState] = React.useState<TicketExportState>("idle");
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = React.useCallback(async () => {
    if (!ticketId || state === "working") return;
    setState("working");
    const toastId = toast.loading("Building the ticket audit PDF…");

    let objectUrl: string | null = null;
    try {
      const res = await fetch(`/api/board/tickets/${ticketId}/export`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));

      // Belt-and-braces: a 200 that is not a PDF is still not a PDF. Saving it
      // under a .pdf name would reintroduce exactly the bug this hook fixes.
      const type = res.headers.get("Content-Type") ?? "";
      if (!type.includes("application/pdf")) {
        throw new Error(`The server returned ${type || "an unknown type"} instead of a PDF.`);
      }

      const blob = await res.blob();
      // The route already built the filename (it is the one place that escapes
      // an agent-authorable title for a response header); prefer it over
      // re-deriving one here and getting the escaping subtly different.
      const filename = filenameFromDisposition(res.headers.get("Content-Disposition"));
      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename ?? `ticket-${ticketId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success("Ticket audit PDF ready", { id: toastId, description: "Downloading…" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Ticket export failed", { id: toastId, description: message });
    } finally {
      // Revoke only after the click has been handed to the browser; doing it in
      // the same tick as `click()` can cancel the download in some browsers.
      const url = objectUrl;
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (alive.current) setState("idle");
    }
  }, [ticketId, state]);

  return { state, start, busy: state === "working" };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return `${body.error} (HTTP ${res.status})`;
  } catch {
    // Not JSON — fall through to the bare status.
  }
  return `The export could not be produced (HTTP ${res.status}).`;
}

/**
 * Pull the filename out of `Content-Disposition`.
 *
 * Reads `filename*=UTF-8''…` (RFC 5987) in preference to `filename=…`, which is
 * the order the spec asks for and matters here because a ticket title can be
 * non-ASCII. Anything unparseable yields null and the caller's fallback name is
 * used — a wrong-but-safe filename beats failing a download that succeeded.
 */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const ext = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (ext) {
    try {
      return decodeURIComponent((ext[1] ?? "").trim()) || null;
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header) ?? /filename=([^;]+)/i.exec(header);
  return plain ? (plain[1] ?? "").trim() || null : null;
}
