import { describe, expect, it, vi } from "vitest";
import {
  EVENT_SEND_TIMEOUT_MS,
  EventSendTimeoutError,
  withSendTimeout,
} from "@/lib/engine/send-bounded";

/** A promise that never settles - the shape `inngest.send` takes on when the
 *  event endpoint accepts the connection and then answers nothing. */
function hangs(): Promise<never> {
  return new Promise<never>(() => {});
}

describe("withSendTimeout", () => {
  it("rejects with EventSendTimeoutError when the work never settles", async () => {
    // The defect in one line: without the bound this expectation never resolves,
    // and the test times out instead of failing.
    await expect(withSendTimeout(hangs, { label: "x/y", timeoutMs: 20 })).rejects.toBeInstanceOf(
      EventSendTimeoutError,
    );
  });

  it("names the event and the ceiling so the failure is diagnosable", async () => {
    const err = await withSendTimeout(hangs, {
      label: "workspace/cleanup-requested",
      timeoutMs: 15,
    })
      .then(() => null)
      .catch((e: unknown) => e as EventSendTimeoutError);
    expect(err).toBeInstanceOf(EventSendTimeoutError);
    expect(err?.label).toBe("workspace/cleanup-requested");
    expect(err?.timeoutMs).toBe(15);
    expect(err?.message).toContain("workspace/cleanup-requested");
    expect(err?.message).toContain("15ms");
  });

  it("does not wait out the timeout on a healthy send", async () => {
    const started = Date.now();
    // A 10s ceiling: if the bound were awaited rather than raced, this test
    // would take 10s and the suite would notice.
    await expect(
      withSendTimeout(async () => "ok", { label: "x/y", timeoutMs: 10_000 }),
    ).resolves.toBe("ok");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("rethrows a transport error unchanged - a real error is not a timeout", async () => {
    const boom = new Error("connect ECONNREFUSED 127.0.0.1:8288");
    await expect(
      withSendTimeout(() => Promise.reject(boom), { label: "x/y", timeoutMs: 5_000 }),
    ).rejects.toBe(boom);
  });

  it("propagates a synchronous throw from the work thunk", async () => {
    const boom = new Error("sync");
    await expect(
      withSendTimeout(
        () => {
          throw boom;
        },
        { label: "x/y", timeoutMs: 5_000 },
      ),
    ).rejects.toBe(boom);
  });

  it("clears the timer on success, so a healthy send leaves nothing pending", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const before = clearSpy.mock.calls.length;
    await withSendTimeout(async () => "ok", { label: "x/y", timeoutMs: 10_000 });
    expect(clearSpy.mock.calls.length).toBeGreaterThan(before);
    clearSpy.mockRestore();
  });

  it("a late rejection from the losing promise does not surface as an unhandled rejection", async () => {
    // Promise.race attaches handlers to every entrant, so the send rejecting
    // AFTER we gave up is already handled. Pinned because an unhandled rejection
    // crashes a Node server process.
    let rejectLate: (e: Error) => void = () => {};
    const late = new Promise<never>((_r, rej) => {
      rejectLate = rej;
    });
    await expect(
      withSendTimeout(() => late, { label: "x/y", timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(EventSendTimeoutError);
    rejectLate(new Error("arrived after the bound"));
    // Give the microtask queue a turn; an unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 10));
  });

  it("defaults to EVENT_SEND_TIMEOUT_MS, which is bounded and operator-scale", () => {
    // Not a latency budget: far above any healthy send, far below "forever".
    expect(EVENT_SEND_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(EVENT_SEND_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
