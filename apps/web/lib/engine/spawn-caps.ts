// The spawn ceilings, as plain numbers. MARKER-FREE BY CONSTRUCTION - this file
// imports nothing, so anything may read the caps without dragging in a
// `server-only` chain.
//
// ── WHY THEY MOVED OUT OF `spawning.ts` ───────────────────────────────────
// They did not change. `spawning.ts` re-exports all three, so every existing
// import site is byte-for-byte unaffected and there is still exactly ONE
// declaration of each number.
//
// What changed is who can READ them. `spawning.ts` imports `supabaseService`,
// which reaches `next/headers`, so nothing that imports it can load under
// Vitest - and the supervisor console's command vocabulary is a PURE module
// that has to state a team-size ceiling to an operator BEFORE anything is
// spawned. The alternative was for that module to re-declare the numbers, which
// is exactly the drift this codebase refuses to grow: a console that offers a
// team of 6 while the engine refuses at 4 is a button that does nothing, and a
// console that refuses at 3 while the engine would have allowed 4 is a tool
// that lies about its own limits.
//
// ⚠️ THESE ARE THE SPAWN-TREE CAPS, NOT THE COHORT CAP. `MAX_FAN_OUT` here
// bounds how many children ONE PARENT RUN may spawn through
// `devpilot_spawn_agent`; `lib/engine/fan-out.ts` exports a DIFFERENT constant of
// the same name that bounds how many SIBLINGS one dispatcher cohort may emit.
// They are separate mechanisms with separate policies and happen to share a
// default. Import the one that matches the path you are on.
//
// CLAUDE.md §3 (P0, non-negotiable): "Hard ceilings everywhere. No agent spawn
// without passing: max recursion depth, max total agents, max fan-out, and
// remaining budget."

/** Max recursion depth of the spawn tree. Root is depth 0, so 3 permits
 *  children at depths 1, 2 and 3. */
export const MAX_DEPTH = Number(process.env.DEVPILOT_MAX_DEPTH ?? "3");

/** Max children ONE parent run may spawn. See the warning above - this is the
 *  spawn-tree cap, not `fan-out.ts`'s cohort cap. */
export const MAX_FAN_OUT = Number(process.env.DEVPILOT_MAX_FAN_OUT ?? "4");

/** Max simultaneously-active runs in ONE tenant. Tenant-scoped so a runaway in
 *  one workspace cannot block another's ordinary traffic. */
export const MAX_TOTAL_AGENTS = Number(process.env.DEVPILOT_MAX_TOTAL_AGENTS ?? "20");

/** The run statuses that count against `MAX_TOTAL_AGENTS`. */
export const ACTIVE_RUN_STATUSES = ["running", "awaiting_human"] as const;
