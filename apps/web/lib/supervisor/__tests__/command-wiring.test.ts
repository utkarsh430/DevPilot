// Source-scan guards for the COMMAND half.
//
// These are claims about EVERY path rather than about one call, which a runtime
// test cannot make - and the two files they most need to cover
// (`console-server-actions.ts`, which reaches `next/headers`, and
// `command-store.server.ts`, which reaches `server-only`) cannot load under
// Vitest at all. That is exactly the gap defects in this codebase keep living
// in, so the properties are asserted against the source text.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "lib", "supervisor");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

describe("the marker-free split still holds with the command half in", () => {
  it("only the `.server.ts` twins import `server-only`", () => {
    for (const f of files) {
      expect(/^import "server-only";/m.test(read(f)), `${f} imports server-only`).toBe(
        f.endsWith(".server.ts"),
      );
    }
  });

  it("the command modules import no execution primitive as a VALUE", () => {
    // Every one of these reaches `server-only`. A value import would silently
    // remove the command path from the suite, which is how the console's
    // previous defects survived review.
    const forbidden = [
      "transitionTicket",
      "createTicketCore",
      "pauseTicket",
      "resumeTicket",
      "resolveDependencyRefs",
      "insertTicketDependencies",
      "supabaseService",
      "sendEventBounded",
    ];
    for (const f of ["console-commands.ts", "command-store.ts"]) {
      const src = read(f);
      for (const name of forbidden) {
        expect(src, `${f} value-imports ${name}`).not.toMatch(
          new RegExp(`import\\s*\\{[^}]*\\b${name}\\b`),
        );
      }
    }
  });
});

describe("the command path reimplements nothing", () => {
  it("every primitive is the engine's own function, called from the wiring", () => {
    const w = read("command-store.server.ts");
    for (const call of [
      "transitionTicket({",
      "createTicketCore({",
      "pauseTicket({",
      "resumeTicket({",
      "resolveDependencyRefs({",
      "loadBlockingEdgeClosure({",
      "insertTicketDependencies(rows)",
      "countActiveRunsForTenant(",
      "composeRoleSystemPrompt(",
    ]) {
      expect(w, `wiring does not call ${call}`).toContain(call);
    }
  });

  it("the cycle guard is the shared one, called on the tested path", () => {
    // `planTicketDependencies` is what refuses a deadlock, and a deadlocked
    // pair is permanent and invisible. It must live in the marker-free store
    // where a test can drive it, not in the `.server.ts` twin.
    expect(read("command-store.ts")).toContain("planTicketDependencies({");
    expect(read("command-store.server.ts")).not.toContain("planTicketDependencies");
  });

  it("the team ceilings are imported from the engine, never re-declared", () => {
    const src = read("console-commands.ts");
    expect(src).toMatch(/from "@\/lib\/engine\/fan-out"/);
    expect(src).toContain("planFanOut(");
    expect(src).toContain("validateCohortPlan(");
    // A local re-declaration of any cap is the drift this is written to stop:
    // a console that offers a team the engine refuses is a button that does
    // nothing, and one that refuses a team the engine allows is a tool lying
    // about its own limits.
    expect(src).not.toMatch(/const\s+MAX_(FAN_OUT|TOTAL_AGENTS|DEPTH)\s*=/);
  });

  it("the transition is always as a HUMAN, and the actor is not a parameter", () => {
    // A caller-supplied actor would be a way to launder an agent move through
    // the console - the L1 QA hand-off gate and the SME safety gate both key
    // on that discriminator.
    const w = read("command-store.server.ts");
    expect(w).toContain('actor: "human"');
    const store = read("command-store.ts");
    expect(store).not.toMatch(/actor\s*[:?]\s*(TransitionActor|string)/);
  });
});

describe("the model's reply schema did not grow a target", () => {
  it("`ConsoleReplySchema` still has no ticket, agent, status or free-form action field", () => {
    // THE structural half of the injection defence. The command vocabulary is
    // wider; the model's ability to express a target is not, and this is the
    // assertion that keeps it that way when someone reaches for "just let it
    // return the ticket key".
    const brief = read("console-brief.ts");
    const start = brief.indexOf("export const ConsoleReplySchema");
    const end = brief.indexOf("export type ConsoleReply ");
    expect(start).toBeGreaterThan(0);
    const schema = brief.slice(start, end);
    for (const banned of ["ticketId", "ticketKey", "agentId", "status", "role", "commandKind"]) {
      expect(schema, `schema grew a ${banned} field`).not.toContain(banned);
    }
  });

  it("targets come from the operator's question and from nothing else", () => {
    const src = read("console-commands.ts");
    const start = src.indexOf("export function deriveOperatorTargets");
    const end = src.indexOf("// ─────", start);
    const body = src.slice(start, end);
    expect(body).toContain("extractTicketKeys(question)");
    // Not from the tickets themselves, not from a reply.
    expect(body).not.toMatch(/\.title\b/);
    expect(body).not.toMatch(/\bnotice\b/);
    expect(body).not.toMatch(/\breply\b/);
  });
});

describe("the emit is bounded on this request path", () => {
  it("uses `sendEventBounded`, never a raw `inngest.send`", () => {
    const w = read("command-store.server.ts");
    expect(w).toContain("sendEventBounded");
    expect(w).not.toMatch(/\binngest\.send\(/);
  });
});

describe("the server-action layer holds no policy", () => {
  it("routes COMMAND through `runConsoleCommand` and takes no tenant id", () => {
    const a = read("console-server-actions.ts");
    expect(a).toContain("runConsoleCommand");
    expect(a).toContain("requireTenantId()");
    expect(a).not.toMatch(/input\.tenantId/);
  });

  it("takes the operator's QUESTION, not a ticket id, as the target", () => {
    // A ticket id on the wire would be a target the CLIENT chose. The whole
    // design is that the target comes from the operator's words, so the client
    // sends the words back and the server re-parses them.
    const a = read("console-server-actions.ts");
    const start = a.indexOf("export async function runSupervisorConsoleCommandAction");
    const body = a.slice(start, a.indexOf("\n}", start));
    expect(body).toContain("question:");
    expect(body).not.toMatch(/input\.ticketId/);
  });
});

describe("the autonomous supervisor is not weakened", () => {
  const policy = readFileSync(join(process.cwd(), "lib", "engine", "supervisor-policy.ts"), "utf8");

  it("`planSupervision` still returns EMPTY remediations in observe mode", () => {
    // The structural property the autonomous half rests on: a second actor
    // doing the reapers' job on a healthy board is the two-writer problem, so
    // an observing pass must be provably incapable of remediating. Nothing in
    // the command half touches it - commanding is a different case, argued in
    // `console-actions.ts` - and this pins that it stayed untouched.
    const start = policy.indexOf("export function planSupervision");
    const body = policy.slice(start);
    expect(body).toMatch(
      /if \(mode === "observe"\) \{\s*\n\s*return \{[^}]*remediations: \[\][^}]*\};/,
    );
    // The remediation array is only constructed BELOW that early return.
    const gate = body.indexOf('if (mode === "observe")');
    const built = body.indexOf("const remediations:");
    expect(built).toBeGreaterThan(gate);
  });

  it("only `operator_command` is exempt from the indictment", () => {
    // A DENYLIST: a future defect cause is indicted by default and has to be
    // argued out of it. A silent defect is worse than a visible false alarm.
    expect(policy).toMatch(
      /NON_INDICTABLE_CAUSES:\s*ReadonlySet<SupervisorCause>\s*=\s*new Set\(\["operator_command"\]\)/,
    );
  });
});
