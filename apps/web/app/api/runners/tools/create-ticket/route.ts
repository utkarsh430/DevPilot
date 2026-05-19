// POST /api/runners/tools/create-ticket
//
// WI-14 - MCP-backed board tool. An engineer agent that finds genuinely
// out-of-scope work calls `devpilot_create_ticket({ title, description })`; the MCP
// relay forwards here with the run context the runner injected
// (DEVPILOT_RUN_ID / DEVPILOT_TICKET_ID / DEVPILOT_ROLE).
//
// This is a runner-authed WRITE that creates work which can later become a
// billable run, so it is the highest-risk tool surface added since
// `devpilot_spawn_agent`. The full envelope, in the order it is enforced:
//
//   1. Runner key (`x-devpilot-runner-key`) - same gate as every other tool route.
//   2. UNTRUSTED input bounds - title 3..200, description ≤ 8000. Agent text is
//      data, never instructions (AGENTS.md principle 6).
//   3. Tenant + project are read off the SPAWNING TICKET (body.ticketId, i.e.
//      the injected DEVPILOT_TICKET_ID) via the service client. The tool's
//      inputSchema does not even accept a projectId/tenantId - there is no
//      client-supplied value to trust, so there is nothing to spoof. A
//      ticket-less run (supervisor child, replay of a ticket-less original)
//      is refused outright: it has no project to file into.
//   4. `projects.agent_ticket_creation` - per-project opt-in, OFF by default.
//   5. Durable per-run fan-out cap (`runs.tickets_created_count`, claimed
//      atomically). The ceiling resolves project » env » default. Structured
//      refusal code at the cap.
//   6. Deterministic normalized-title dedupe against the project's OPEN tickets.
//
// (5b) DECLARED DEPENDENCIES. `dependsOn` names the tickets that must finish
// first; the edges are real `ticket_dependencies` rows, so the drain and the
// `→ ready` guard actually honour them. Before this existed the tool had no way
// to say it, and four decompositions on one board wrote the ordering into prose
// that the scheduler cannot read - see `lib/board/ticket-deps.ts` for the
// incident and the design.
//
// Two orderings in this file carry the whole safety story for it:
//
//   • Every reference is resolved and every refusal is decided BEFORE the ticket
//     row is inserted. The route pre-generates the ticket's uuid so the cycle
//     guard can run against the real id without the row existing yet. That is
//     what makes a bad dependency leave NOTHING behind - not a ticket, not a
//     burnt slot, not a half-wired graph.
//   • Resolution is scoped to the SPAWNING TICKET's tenant AND project, so
//     `dependsOn` cannot become the way around (3). A blocker id from another
//     project or another workspace does not resolve, and does not get honoured.
//
// Both refusals in (4) and (5) NAME THE CONTROL AND THE PAGE. That is not
// politeness: a refusal is the only thing an operator ever sees of this route
// (via the agent's escalation), so it is the documentation. See the copy block
// in `lib/board/agent-ticket.ts` for the incident that established it.
//
// And the property that makes the whole thing safe even if one of the above
// were bypassed: the ticket lands in `backlog` with `requested_role = null`.
// Nothing dispatches from `backlog` - a human (or the unblock promoter, itself
// per-project opt-in) has to move it to `ready`. There is NO path from this
// route to a run start.
//
// Auth: x-devpilot-runner-key.
// Request:  { ticketId, runId, title, description?, alias?, dependsOn?, role?,
//             runnerId? }
// Response 200 (created): { ticketId, ticketKey, alias, dependsOn,
//                           dependenciesRecorded, filedThisRun, maxPerRun,
//                           maxPerRunSource, remainingThisRun,
//                           provenanceRecorded, warning? }
// Response 200 (dedupe):  { ticketId, deduped: true, message }
// Response 403: { error, code } - cap / opt-in refusals
// Response 4xx: validation / lookup / dependency refusals

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { addComment } from "@/lib/board/transitions";
import { fenceUntrustedOutput } from "@/lib/board/qa-gate";
import { createTicketCore } from "@/lib/board/create-ticket";
import {
  describeNotEnabledRefusal,
  describeTicketCapRefusal,
  findDuplicateTicket,
  resolveMaxTicketsPerRun,
  validateAgentTicketInput,
  type AgentTicketRefusal,
} from "@/lib/board/agent-ticket";
import { claimAgentTicketSlot, loadDuplicateCandidates } from "@/lib/board/agent-ticket.server";
import { formatTicketKey } from "@/lib/board/ticket-key";
import {
  describeDuplicateAliasRefusal,
  describeUnknownBlockerRefusal,
  describeUnsatisfiableBlockers,
  planTicketDependencies,
  validateAgentDependencyInput,
  type TicketDependencyRow,
} from "@/lib/board/ticket-deps";
import {
  aliasTakenThisRun,
  insertTicketDependencies,
  loadBlockingEdgeClosure,
  loadRunAliases,
  resolveDependencyRefs,
  type ResolvedBlocker,
} from "@/lib/board/ticket-deps.server";

export const dynamic = "force-dynamic";

type CreateTicketBody = {
  /** The SPAWNING ticket - the one the calling agent is working on. Injected by
   *  the runner as DEVPILOT_TICKET_ID; the agent cannot choose it. Tenant + project
   *  for the new ticket are derived from THIS row and nowhere else. */
  ticketId?: string;
  /** The calling run - DEVPILOT_RUN_ID. Keys the durable fan-out counter. */
  runId?: string;
  title?: unknown;
  description?: unknown;
  /** Run-local label for the ticket being created, so a later call on this run
   *  can name it in `dependsOn`. UNTRUSTED - shape-gated. */
  alias?: unknown;
  /** Blockers: aliases from earlier calls on this run, `DevPilot-<N>` keys, or
   *  uuids. UNTRUSTED - every entry is resolved against THIS project. */
  dependsOn?: unknown;
  role?: string;
  runnerId?: string;
};

/** Same conservative shape gate the comment route uses on its author slug: a
 *  typo in the env must not be able to render as arbitrary text. */
const ROLE_SLUG_RE = /^[a-z][a-z0-9_]{0,63}$/;

function refuse(refusal: AgentTicketRefusal, status: number) {
  return NextResponse.json({ error: refusal.reason, code: refusal.code }, { status });
}

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const body = (await request.json().catch(() => null)) as CreateTicketBody | null;

  // (3, first half) - no spawning ticket / no run = no context to derive from.
  // The MCP relay refuses this before it gets here; the route refuses it again
  // because "the relay checks" is not a security boundary.
  if (!body?.ticketId || typeof body.ticketId !== "string") {
    return refuse(
      {
        code: "no-ticket-context",
        reason:
          "devpilot_create_ticket needs the ticket you are working on (DEVPILOT_TICKET_ID); this run has none.",
      },
      400,
    );
  }
  if (!body.runId || typeof body.runId !== "string") {
    return refuse(
      {
        code: "no-ticket-context",
        reason:
          "devpilot_create_ticket needs the calling run (DEVPILOT_RUN_ID); this run has none.",
      },
      400,
    );
  }

  // (2) - UNTRUSTED agent text, bounded before it touches anything.
  const validated = validateAgentTicketInput({ title: body.title, description: body.description });
  if (!validated.ok) return refuse(validated.refusal, 400);
  const { title, description } = validated;

  // (2b) - the same treatment for the two dependency fields. Shape only: what
  // the references POINT AT is decided in (5b), once we know which project we
  // are allowed to look in.
  const depInput = validateAgentDependencyInput({
    alias: body.alias,
    dependsOn: body.dependsOn,
  });
  if (!depInput.ok) {
    return refuse({ code: "invalid-input", reason: depInput.reason }, 400);
  }
  const { alias, refs } = depInput.value;

  const supabase = supabaseService();

  // (3, second half) - tenant AND project come off the spawning ticket. This is
  // the whole reason the tool takes no project/tenant argument: an agent that
  // could name its own project could file into a project it was never
  // dispatched against, and (worse) into another tenant's.
  const { data: sourceTicket, error: sourceErr } = await supabase
    .from("tickets")
    .select("id, tenant_id, project_id")
    .eq("id", body.ticketId)
    .single();
  if (sourceErr || !sourceTicket) {
    return NextResponse.json({ error: "ticket not found" }, { status: 404 });
  }
  const tenantId = sourceTicket.tenant_id as string;
  const projectId = sourceTicket.project_id as string | null;
  if (!projectId) {
    return refuse(
      {
        code: "no-ticket-context",
        reason:
          "The ticket you are working on has no project, so there is no backlog to file into.",
      },
      400,
    );
  }

  // (4) - per-project opt-in, OFF by default. The same read also carries the
  // per-project rung of the ticket ceiling (5), so the two settings that decide
  // whether this call succeeds come from one row rather than two round trips.
  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .select("id, agent_ticket_creation, agent_ticket_max_per_run")
    .eq("id", projectId)
    .single();
  if (projectErr || !project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }
  if (project.agent_ticket_creation !== true) {
    // The refusal names the control and the page. It is the ONLY text an
    // operator sees when the agent escalates, so it has to be actionable
    // without reading source - see the copy block in `agent-ticket.ts`.
    return refuse(describeNotEnabledRefusal(projectId), 403);
  }

  // (6) - dedupe BEFORE claiming a slot: an agent that re-files an existing
  // ticket has created nothing, so it must not burn a slot for it. (Doing it in
  // the other order would let a duplicate-happy agent exhaust its own cap
  // without a single new ticket to show for it.)
  //
  // Read-then-insert, so two runs filing the same title at the same instant can
  // both miss. That is deliberate: dedupe is a NOISE control, not the security
  // boundary - the per-run cap below is, and that one IS atomic. Paying for a
  // unique index (or an advisory lock) on a normalized title would buy a
  // duplicate-free backlog at the cost of a schema constraint no human-created
  // ticket could satisfy.
  const candidates = await loadDuplicateCandidates({ tenantId, projectId });
  const duplicate = findDuplicateTicket(title, candidates);
  if (duplicate) {
    return NextResponse.json({
      ticketId: duplicate.id,
      deduped: true,
      message:
        `An open ticket with this title already exists (${duplicate.id}). Nothing was created.` +
        // Say so out loud. Quietly discarding a declared ordering is the exact
        // failure this whole argument exists to end, and it would be worse here
        // than anywhere else - the agent has every reason to believe an edge it
        // asked for on a 200 response was written. DevPilot deliberately does not
        // wire them onto the existing ticket instead: that row may be a human's,
        // and adding blockers to it could wedge work nobody asked us to touch.
        (refs.length > 0
          ? ` Your dependsOn entries were NOT applied to it - if ${duplicate.id} really does ` +
            "need those blockers, say so in a comment so a human can wire them."
          : ""),
    });
  }

  // (5b) - DECLARED DEPENDENCIES, resolved and adjudicated before anything is
  // written. Everything below this point up to the slot claim can refuse, and
  // every one of those refusals leaves the board exactly as it found it: no
  // ticket, no edges, and no slot consumed.
  //
  // The id is generated HERE, server-side, rather than by Postgres, so the cycle
  // guard can reason about the real node before the row exists. Nothing about it
  // comes from the agent.
  const newTicketId = crypto.randomUUID();

  if (alias && (await aliasTakenThisRun({ tenantId, runId: body.runId, alias }))) {
    return refuse(describeDuplicateAliasRefusal(alias), 409);
  }

  let dependencyRows: TicketDependencyRow[] = [];
  let blockers: ResolvedBlocker[] = [];
  if (refs.length > 0) {
    // Scoped to the SPAWNING ticket's tenant AND project. A reference that names
    // a ticket outside them does not resolve - which is how the security
    // boundary in (3) survives the arrival of a dependency argument.
    const resolved = await resolveDependencyRefs({
      tenantId,
      projectId,
      runId: body.runId,
      refs,
    });
    if (resolved.unresolved.length > 0) {
      return refuse(
        describeUnknownBlockerRefusal({
          unresolved: resolved.unresolved,
          aliasesDefinedThisRun: await loadRunAliases({
            tenantId,
            projectId,
            runId: body.runId,
          }),
        }),
        400,
      );
    }
    blockers = resolved.blockers;

    const existingEdges = await loadBlockingEdgeClosure({
      tenantId,
      fromTicketIds: blockers.map((b) => b.ticketId),
    });
    const plan = planTicketDependencies({ newTicketId, blockers, existingEdges });
    if (!plan.ok) return refuse(plan.refusal, 409);
    dependencyRows = plan.rows;
  }

  // (5) - durable per-run fan-out cap. Atomic claim, so two concurrent tool
  // calls from the same run cannot both take the last slot.
  //
  // The ceiling resolves project » env » default. One instance-wide number
  // cannot serve both an engineer filing the odd stray finding and a
  // decomposition ticket that is SUPPOSED to fan out to five children, so the
  // project rung exists to raise it for the latter without raising it for every
  // board on the instance.
  const ceiling = resolveMaxTicketsPerRun({
    project: project.agent_ticket_max_per_run as number | null | undefined,
    env: process.env.DEVPILOT_MAX_TICKETS_PER_RUN,
  });
  const maxTickets = ceiling.max;
  const claim = await claimAgentTicketSlot(body.runId, maxTickets);
  if (!claim.ok) {
    if (claim.reason === "run-not-found") {
      return NextResponse.json({ error: `run ${body.runId} not found` }, { status: 404 });
    }
    // Hitting the cap mid-decomposition is the one refusal that can be mistaken
    // for success: the children that exist and the ones that never got filed
    // look identical on the board afterwards. The copy says so outright.
    return refuse(
      describeTicketCapRefusal({ max: maxTickets, source: ceiling.source, projectId }),
      403,
    );
  }

  // Backlog-only, role-less. Both are forced here, not defaulted: an agent may
  // not aim a ticket at a role (which also keeps the UI-only Runners gate
  // inert), and may not file straight into `ready`, which is what would turn
  // this tool into a direct run start.
  const created = await createTicketCore({
    tenantId,
    projectId,
    title,
    description,
    supabase,
    status: "backlog",
    requestedRole: null,
    sourceRunId: body.runId,
    ticketId: newTicketId,
    agentAlias: alias,
    // Board ORDER, not the graph: land the child below the tickets it waits for,
    // so a decomposition reads top-to-bottom the way it will actually run.
    placeAfterTicketIds: blockers.map((b) => b.ticketId),
  });
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: 500 });
  }

  // The edges. Everything that could refuse has already refused, so this is the
  // one dependency write, and it is ONE insert of the whole set - a
  // decomposition that recorded three of five edges would be the original bug
  // with extra steps.
  //
  // A failure here is reported, never swallowed and never turned into a 500: the
  // ticket exists, so a 500 would invite the agent to file it again, and the
  // silent version is precisely the failure mode this feature was built to end.
  // `dependenciesRecorded` is in EVERY response, including the `[]` case, so an
  // agent can check one field rather than infer from an absence.
  const depWrite = await insertTicketDependencies(dependencyRows);
  const dependenciesRecorded = depWrite.ok;
  const warnings: string[] = [];
  if (!depWrite.ok) {
    console.warn(
      `[create-ticket] dependency rows failed for ${created.ticketId}: ${depWrite.error}`,
    );
    warnings.push(
      `The ticket was created, but its ${dependencyRows.length} declared dependency/dependencies ` +
        "could NOT be recorded, so nothing is holding it back and it may be picked up out of " +
        "order. Do not report the ordering as in place - say in a comment which tickets it " +
        "should have waited for.",
    );
  } else {
    const unsatisfiable = describeUnsatisfiableBlockers(
      blockers.map((b) => ({
        ref: formatTicketKey(b.ticketNumber, b.ticketId),
        status: b.status,
      })),
    );
    if (unsatisfiable) warnings.push(unsatisfiable);
  }

  // The trace is the product - leave the provenance where a human will actually
  // see it: on the ticket the agent was working when it filed this. The agent's
  // own title/description are fenced; they are untrusted text that lands in
  // another agent's context when the next role reads this ticket's comments.
  //
  // `role` is the SLUG the runner injected (DEVPILOT_ROLE), shape-gated the same way
  // the comment route gates its author_id - it is rendered into agent-visible
  // text, so a junk value must not be able to dress itself up as anything else.
  const filedBy = typeof body.role === "string" && ROLE_SLUG_RE.test(body.role) ? body.role : null;
  // The OTHER thing on this path that can partially succeed and look total: the
  // ticket exists but its breadcrumb does not, so the source ticket shows no
  // sign that anything was filed from it. Reported in the response rather than
  // only in a server log the operator will never read - a missing audit trail
  // is worth one line in the trace.
  let provenanceRecorded = true;
  try {
    await addComment({
      ticketId: sourceTicket.id as string,
      tenantId,
      authorType: "system",
      authorId: "devpilot_agent_ticket",
      body:
        `${filedBy ? `\`${filedBy}\` filed` : "Filed"} a new backlog ticket for out-of-scope work ` +
        `found while working this one (${claim.count}/${maxTickets} allowed from this run). It ` +
        `sits in **Backlog** and will not run until a human promotes it.` +
        // The declared ordering belongs in the breadcrumb too. These are ticket
        // KEYS DevPilot resolved, not agent text - so they are outside the fence,
        // and they are what lets a human read the shape of a decomposition off
        // the parent ticket instead of opening every child.
        (blockers.length > 0
          ? ` Blocked by ${blockers
              .map((b) => formatTicketKey(b.ticketNumber, b.ticketId))
              .join(", ")}${dependenciesRecorded ? "" : " — **these edges failed to record**"}.`
          : "") +
        fenceUntrustedOutput(
          `agent-proposed ticket (${created.ticketId})`,
          `${title}\n\n${description}`,
        ),
      metadata: {
        kind: "agent_ticket_created",
        ticketId: created.ticketId,
        runId: body.runId,
        role: filedBy,
        alias,
        dependsOn: blockers.map((b) => b.ticketId),
        dependenciesRecorded,
      },
    });
  } catch (err) {
    // The ticket exists; losing its breadcrumb must not fail the tool call.
    provenanceRecorded = false;
    console.warn(
      `[create-ticket] provenance comment failed for ${created.ticketId}: ${String(err)}`,
    );
  }

  // `remainingThisRun` is stated rather than left to the agent to derive: an
  // agent part-way through a decomposition needs to know how many more it may
  // file BEFORE it hits the cap, which is the difference between reordering its
  // remaining children and discovering the truncation after the fact.
  return NextResponse.json({
    ticketId: created.ticketId,
    // The key the board prints on the card. Returned so the agent can reference
    // this ticket in a later `dependsOn` even when it gave it no alias, and so
    // anything it writes into a comment names the ticket the way a human will
    // see it (`formatTicketKey` - never `column_position`).
    ticketKey: formatTicketKey(created.ticketNumber, created.ticketId),
    alias,
    dependsOn: blockers.map((b) => ({
      ref: b.ref,
      ticketId: b.ticketId,
      ticketKey: formatTicketKey(b.ticketNumber, b.ticketId),
    })),
    dependenciesRecorded,
    filedThisRun: claim.count,
    maxPerRun: maxTickets,
    maxPerRunSource: ceiling.source,
    remainingThisRun: Math.max(0, maxTickets - claim.count),
    provenanceRecorded,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  });
}
