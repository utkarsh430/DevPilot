// Phase 1 / M15 — one-shot runner for the meter aggregator.
//
// Invoked by phase1-m15-accept.mjs via tsx (the same indirection M10's
// validator test uses). Reads tenantId from argv[2], calls
// aggregateTenant once, and prints the JSON result to stdout on a known
// marker line so the parent can parse it.

import { aggregateTenant } from "../lib/billing/meter.js";

const tenantId = process.argv[2];
if (!tenantId) {
  console.error("usage: tsx phase1-m15-aggregator-runner.mts <tenantId>");
  process.exit(2);
}

const result = await aggregateTenant({ tenantId });
console.log("___M15_RESULT___" + JSON.stringify(result));
