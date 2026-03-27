"use client";

// A3 — first-dispatch activation nudge. When the tenant's first-ever run
// comes into existence, route the user to the live trace (the product's
// "aha") with a one-time toast that deep-links to the Run Inspector.
//
// Renders nothing — it only watches. Detection is deliberately cheap and
// engine-free: a `limit 2` probe via `firstDispatchProbeAction`, run at most
// once per board mount plus a couple of bounded re-checks when the realtime
// ticket stream shows a ticket entering a dispatched state (the moment the
// engine creates the first run). Shown-once state is a localStorage flag
// following the existing `devpilot:board:*` key convention; tenants with run
// history get the flag set silently on their first probe and are never
// probed (or nudged) again in that browser.

import * as React from "react";
import { useRouter } from "next/navigation";
import { firstDispatchProbeAction } from "@/app/(app)/board/actions";
import type { BoardTicket } from "@/components/board/types";
import { getItemWithLegacy } from "@/lib/storage/legacy-key";
import { toast } from "@/components/ui/sonner";

// A ticket in any of these states implies the engine has dispatched work —
// i.e. a run row exists (or is about to). Backlog/ready/paused don't.
const DISPATCHED_STATUSES = new Set<BoardTicket["status"]>([
  "assigned",
  "in_progress",
  "input_required",
  "blocked",
  "in_review",
  "done",
  "failed",
]);

// The run row can land moments after the ticket flips to a dispatched state;
// re-probe a few times before giving up until the next board visit.
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;

export function FirstDispatchNudge({
  tenantId,
  tickets,
}: {
  tenantId: string;
  tickets: ReadonlyArray<BoardTicket>;
}) {
  const router = useRouter();
  const storageKey = `devpilot:board:firstRunNudge:${tenantId}`;
  // Pre-rename key, read-through only — a tenant already nudged (or silently
  // marked as having run history) must not be re-nudged after the rename.
  const legacyStorageKey = `ace:board:firstRunNudge:${tenantId}`;
  // Once settled (flag present, nudge shown, or tenant has history) the
  // component goes fully inert — no further probes, ever.
  const settled = React.useRef(false);
  const probing = React.useRef(false);
  const [probeTick, setProbeTick] = React.useState(0);

  const anyDispatched = tickets.some((t) => DISPATCHED_STATUSES.has(t.status));

  React.useEffect(() => {
    if (settled.current || probing.current) return;
    try {
      if (getItemWithLegacy(storageKey, legacyStorageKey)) {
        settled.current = true;
        return;
      }
    } catch {
      // Storage unavailable — never nudge rather than nudge repeatedly.
      settled.current = true;
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    probing.current = true;

    void firstDispatchProbeAction()
      .then((res) => {
        probing.current = false;
        if (cancelled || !res.ok) return;
        const probe = res.value;
        if (probe.status === "pending") {
          // No run yet. If the board already shows a dispatched ticket the
          // run row is imminent — schedule a bounded re-probe.
          if (anyDispatched && probeTick < MAX_RETRIES) {
            retryTimer = setTimeout(() => setProbeTick((t) => t + 1), RETRY_DELAY_MS);
          }
          return;
        }
        settled.current = true;
        try {
          window.localStorage.setItem(storageKey, "1");
        } catch {
          // Best-effort — settled.current still stops repeats this session.
        }
        if (probe.status !== "first") return;
        toast("Your first agent is working →", {
          id: "first-dispatch-nudge",
          duration: 15_000,
          description: "It picked up your ticket and is running right now. Follow along live.",
          action: {
            label: "Watch the trace",
            onClick: () => router.push(`/runs/${probe.runId}`),
          },
        });
      })
      .catch(() => {
        probing.current = false;
      });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // `anyDispatched` flipping false→true is the "first ticket just
    // dispatched" signal; `probeTick` drives the bounded retries.
  }, [anyDispatched, probeTick, storageKey, legacyStorageKey, router]);

  return null;
}
