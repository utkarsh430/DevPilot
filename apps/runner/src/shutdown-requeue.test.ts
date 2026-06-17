import assert from "node:assert/strict";
import { test } from "node:test";
import { decideShutdownRequeue, REQUEUE_PUSH_SIDE, requeuePayload } from "./shutdown-requeue.js";

test("a job still preparing or mid-model is requeued; one past its model turn is left to finish", () => {
  assert.equal(decideShutdownRequeue("prep"), "requeue");
  assert.equal(decideShutdownRequeue("model"), "requeue");
  assert.equal(decideShutdownRequeue("post"), "let-finish");
});

test("a requeued job goes to the side the runner pops from next", () => {
  assert.equal(REQUEUE_PUSH_SIDE, "rpush");
});

test("the requeued payload is the job as parsed, byte-stable", () => {
  const job = { jobId: "j", runId: "r", tenantId: "t", iterationIdx: 0, prompt: "p" };
  const once = requeuePayload(job);
  assert.deepEqual(JSON.parse(once), job);
  assert.equal(requeuePayload(JSON.parse(once)), once);
});
