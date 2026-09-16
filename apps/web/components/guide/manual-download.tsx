"use client";

// The download control's stateful half: it holds the hook and hands its three
// values to the presentational button.
//
// The split is not ceremony. `DownloadManualButton` (in `chrome.tsx`) is render-
// tested under the node Vitest, which cannot run a hook that touches `fetch`,
// `Blob` or the DOM. Keeping the wiring in this file — which is never rendered
// by a test — is what lets the button's busy and error states be asserted at all.
//
// The hook itself belongs to the manual crew; see `use-guide-manual.ts`.

import * as React from "react";
import { DownloadManualButton } from "./chrome";
import { useGuideManual } from "./use-guide-manual";

export function ManualDownload({ className }: { className?: string }) {
  const { start, busy, error } = useGuideManual();
  return (
    <DownloadManualButton onDownload={start} busy={busy} error={error} className={className} />
  );
}
