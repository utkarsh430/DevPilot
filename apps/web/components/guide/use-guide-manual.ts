"use client";

// Download the user manual, and surface a failure AS a failure.
//
// Replaces the placeholder PR #162 landed to make the button's placement
// reviewable. The interface is unchanged from that stub — `{ start, busy, error }`,
// consumed by `ManualDownload` and rendered by the presentational
// `DownloadManualButton` — so this is a one-file swap, which is what the stub
// was shaped for.
//
// ── Why a hook and not a plain `<a href="/api/guide/manual" download>` ──────
//
// This MIRRORS `components/export/use-ticket-export.ts`, and the reason is a bug
// that already shipped in this repo once. A `download` anchor does not look at
// the status code. When the route 500s it returns `{"error":"…"}` as JSON, and
// the browser cheerfully saves that JSON body under a `.pdf` name — so the
// operator gets a corrupt "PDF" and no indication anything went wrong. The
// failure is indistinguishable from success until they try to open it.
//
// That hazard is LIVE here, not merely analogous: the manual route can fail for
// the same class of reason the ticket export can (a font face that will not
// register, a style react-pdf refuses). So the click goes through `fetch`, which
// lets us read the status BEFORE committing to a download.
//
// The two checks are not redundant. `res.ok` catches a DECLARED failure; the
// content-type check catches an UNDECLARED one — a 200 that is not a PDF (a
// proxy interstitial, an auth redirect landing on an HTML page) is still not a
// PDF, and saving it under a `.pdf` name reintroduces the whole bug.
//
// ── Errors are returned, not toasted ───────────────────────────────────────
//
// `use-ticket-export.ts` raises a toast because its control lives in a drawer
// that may be dismissed. This one sits on a documentation page whose button has
// a dedicated error slot directly beneath it (`DownloadManualButton`), so the
// message is returned and rendered in place — next to the control that produced
// it, and still on screen when the reader looks back.
//
// Buffering the PDF in JS memory is an accepted trade, as it is for the ticket
// export: it is the only way to inspect the response before saving it. The
// manual is a bounded, static document, so its size is knowable at review time
// rather than being a function of a tenant's data.

import * as React from "react";

export type GuideManualDownload = {
  /** Kick off the download. */
  start: (() => void) | undefined;
  busy: boolean;
  /** Operator-facing failure, rendered under the button. */
  error: string | null;
};

export function useGuideManual(): GuideManualDownload {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = React.useCallback(() => {
    if (busy) return;
    setBusy(true);
    // Clear the previous failure on a fresh attempt: a stale message sitting
    // under a button that is currently working reads as the new attempt having
    // already failed.
    setError(null);

    void (async () => {
      let objectUrl: string | null = null;
      try {
        // NOT `cache: "no-store"` — unlike the ticket export, this response is
        // designed to be cached (see the route header), and forcing a
        // revalidation on every click would throw away the one thing that makes
        // a synchronous render of the longest document in the repo affordable.
        const res = await fetch("/api/guide/manual");
        if (!res.ok) throw new Error(await readError(res));

        const type = res.headers.get("Content-Type") ?? "";
        if (!type.includes("application/pdf")) {
          throw new Error(`The server returned ${type || "an unknown type"} instead of a PDF.`);
        }

        const blob = await res.blob();
        // The route already built the filename (it is the one place a filename
        // becomes a response header in this repo); prefer it over re-deriving
        // one here and getting the escaping subtly different.
        const filename = filenameFromDisposition(res.headers.get("Content-Disposition"));
        objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = filename ?? "devpilot-manual.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (alive.current) setError(message);
      } finally {
        // Revoke only after the click has been handed to the browser; doing it
        // in the same tick as `click()` can cancel the download in some browsers.
        const url = objectUrl;
        if (url) setTimeout(() => URL.revokeObjectURL(url), 60_000);
        if (alive.current) setBusy(false);
      }
    })();
  }, [busy]);

  return { start, busy, error };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return `${body.error} (HTTP ${res.status})`;
  } catch {
    // Not JSON — fall through to the bare status.
  }
  return `The manual could not be produced (HTTP ${res.status}).`;
}

/**
 * Pull the filename out of `Content-Disposition`, preferring the RFC 5987 form.
 *
 * Anything unparseable yields null and the caller's fallback name is used — a
 * wrong-but-safe filename beats failing a download that succeeded.
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
