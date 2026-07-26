"use client";

// Shared realtime connection-status helper.
//
// Supabase Realtime does NOT replay messages missed while a channel was
// disconnected (backgrounded tab, laptop sleep, network blip, or the periodic
// auth-token refresh). A channel silently drops, auto-reconnects, and re-fires
// `SUBSCRIBED` — but every INSERT/UPDATE/DELETE that happened during the gap is
// gone for good. So a subscription that only flips a "Live" flag on SUBSCRIBED
// and never refetches goes permanently stale after the very first drop while
// the pill cheerfully flips back green.
//
// This helper factors out the two things every realtime hook needs to handle
// that correctly:
//
//   1. A 3-state connection status ("connecting" | "live" | "offline") instead
//      of a 2-state boolean, so an indicator can distinguish "still trying"
//      from "the channel errored" (mirrors changes-list-client.tsx's
//      Live/Loading/Offline).
//
//   2. Drop→resubscribe detection: when the channel returns to SUBSCRIBED
//      AFTER a prior observed drop — never on the first subscribe — fire
//      `onReconnect` so the hook can reconcile by refetching its initial data
//      (or router.refresh()). This is keyed on an ACTUAL observed drop, not on
//      "SUBSCRIBED seen twice", so a token-refresh rejoin that never actually
//      lost the socket does not trigger a spurious refetch. Reconcile fires at
//      most ONCE per drop (the drop flag resets before the callback), and a
//      refetch never re-subscribes the channel, so there is no refetch loop.

export type RealtimeStatus = "connecting" | "live" | "offline";

// Supabase's subscribe callback delivers a `REALTIME_SUBSCRIBE_STATES` value
// ("SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR"). We accept the
// widened `string` here so the returned handler is assignable to `.subscribe()`
// without importing the enum at every call site.
export function createSubscribeHandler(opts: {
  isCancelled: () => boolean;
  setStatus: (status: RealtimeStatus) => void;
  onReconnect?: () => void;
  // Seed the "dropped" state so the FIRST successful subscribe reconciles.
  // Used by the manual retry path: a fresh effect run gets a fresh handler, so
  // without this the post-offline resubscribe would re-connect but never
  // refetch the data missed while the socket was wedged.
  startDropped?: boolean;
}): (status: string) => void {
  let everSubscribed = opts.startDropped ?? false;
  let droppedSinceSubscribe = opts.startDropped ?? false;

  return (status: string) => {
    if (opts.isCancelled()) return;

    if (status === "SUBSCRIBED") {
      opts.setStatus("live");
      if (droppedSinceSubscribe) {
        // Reset BEFORE calling back so a reconcile can't re-enter into a loop.
        droppedSinceSubscribe = false;
        opts.onReconnect?.();
      }
      everSubscribed = true;
      return;
    }

    // CHANNEL_ERROR | TIMED_OUT | CLOSED — the channel is not carrying deltas.
    // Only a status change AFTER we were once live counts as a "drop" worth
    // reconciling; a failure on the very first connect just means the initial
    // seed is still authoritative, nothing to recover yet.
    opts.setStatus("offline");
    if (everSubscribed) droppedSinceSubscribe = true;
  };
}
