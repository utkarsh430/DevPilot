// Static detector for the cross-tenant read class. PURE — no IO, no DB.
//
// ── Why a detector at all ───────────────────────────────────────────────────
// This defect class survived three rounds of site-by-site fixes. Each round
// patched the named instances; the next reviewer found more. Patching cannot
// converge, because nothing stops the next reader from writing the same shape.
// So the rule itself is enforced here, mechanically, over the whole app.
//
// ── The class, precisely ────────────────────────────────────────────────────
// A read is IN the class when all three hold:
//
//   1. the table HAS a `tenant_id` column (so a row can carry a tenant that
//      disagrees with the pointer it is attached to), AND
//   2. the query FILTERS by an attacker-controllable pointer — a FK naming a
//      row in another tenant-scoped table (`ticket_id`, `project_id`, `run_id`,
//      `parent_ticket_id`, `blocks_ticket_id`, `source_run_id`, `session_id`…),
//      AND
//   3. the query carries NO `tenant_id` PREDICATE.
//
// Why that is exploitable: every member write policy in this schema pins the
// row's OWN `tenant_id` and says nothing about the pointer. So a hostile tenant
// writes `{tenant_id: them, ticket_id: <our ticket>}` — the policy passes — and
// any RLS-off read keyed on our ticket id hands their row back to us.
//
// ── Why this module is unusually careful ────────────────────────────────────
// The FIRST version of this detector was UNSOUND and missed two live holes in
// files it was scanning:
//
//   • It chunked from `.from(` lazily to the next `;`, so inside a
//     `Promise.all([...])` the first `.from` swallowed its siblings — and if
//     that first table was exempt, the whole block was skipped. `run_verifications`
//     hid there, leaking forged QA evidence.
//   • It tested `chunk.includes("tenant_id")`, which a SELECTED column satisfies.
//     `planning_sessions` selects `tenant_id` and filters only on `project_id`;
//     it read as "scoped" while leaking another tenant's goal summaries.
//
// A detector that cannot catch its own evasions is not a guard, it is a false
// sense of one — worse than nothing, because it ends the search. Hence
// `parseFromChain` walks the ACTUAL chain, `hasTenantPredicate` looks for a real
// filter call, and the test suite asserts the detector flags both evasion shapes.

/** A (child table, pointer column) → parent table edge that the DB must guard. */
export type TenantPointer = { table: string; column: string; parent: string };

/**
 * Tenant→parent pointers stored as a plain `uuid` with NO foreign key, so
 * `tenantPointersFromMigrations` cannot see them.
 *
 * This list is CURATED because the fact it records is not in the schema: without
 * an FK there is nothing mechanical that says `schedule_activity.project_id`
 * means "the project this row belongs to" rather than being an unrelated uuid.
 * It is asserted (the entries must name real tenant-scoped tables and real uuid
 * columns that genuinely lack an FK), and it feeds BOTH the trigger generator
 * and the detector, so a curated entry cannot protect one layer and not the
 * other.
 *
 * Found by sweeping every uuid column on every tenant-scoped table for a
 * parent-shaped name with no `references` clause. Exactly one exists today. If
 * you add a denormalised pointer, add it here — the FK-derived path will not
 * find it for you, and that is precisely the gap that let
 * `schedule_activity.project_id` sit unguarded while the coverage test still
 * claimed to "fail on any gap".
 */
export const NON_FK_TENANT_POINTERS: readonly TenantPointer[] = [
  // 20260610000000_schedule_activity.sql — `project_id uuid` (denormalised for
  // the activity feed's project filter; no FK).
  { table: "schedule_activity", column: "project_id", parent: "projects" },
];

/**
 * A pointer whose child tenant is NOT constrained by its parent's — i.e. a
 * mismatch is LEGAL and expected, so no trigger may guard it and the audit must
 * not report it.
 *
 * `reads` records the half of the question the trigger cannot answer, and it is
 * the half that is easy to get backwards (see the header note below):
 *
 *  • "scoped-read" — a read keyed on this pointer STILL has an owning tenant, so
 *    it still needs `.eq("tenant_id", …)`. Marketplace provenance is this:
 *    "which of MY skills were installed from public skill X" is a perfectly
 *    scoped question, and answering it unscoped would leak which OTHER tenants
 *    installed X. The pointer is cross-tenant; the read is not.
 *
 *  • "platform-internal" — a read keyed on this pointer has NO owning tenant and
 *    MUST see every tenant's rows. Adding `.eq("tenant_id", …)` does not harden
 *    it, it BREAKS it. These columns are removed from the detector's vocabulary,
 *    because flagging them would demand a "fix" that is a bug.
 */
export type CrossTenantRelation = TenantPointer & {
  reason: string;
  reads: "scoped-read" | "platform-internal";
};

/**
 * Pointers that are cross-tenant BY DESIGN. THE single exclusion set: the
 * trigger coverage test, the detector vocabulary, and the prod audit all read
 * it, so an entry cannot exempt one layer and not another.
 *
 * ── Why this list exists in this shape ─────────────────────────────────────
 * Round 5 made the POINTER set schema-derived so the two guard layers could not
 * drift. It left the EXCLUSION set hand-copied into three places (this test, the
 * migration's prose, the audit's prose) — and an exclusion is exactly as
 * load-bearing as an inclusion, in the opposite direction: a WRONG exclusion
 * opens a hole, and a MISSING one wedges legitimate work.
 *
 * The missing one is not hypothetical. Round 4 asserted that
 * `trg_runs_runner_id_tenant` proved "a run's runner is always in the run's
 * tenant" — but that trigger was round 4's OWN invention, encoding the very
 * assumption it was then cited to justify. Runners are SHARED: one runner
 * legitimately executes runs for several tenants (the claim route deliberately
 * does not tenant-filter), and prod had 8 such runs. The trigger would have
 * REJECTED the next legitimate cross-tenant claim and wedged the run; the
 * matching app-layer filters made the watchdog blind to exactly the runs it
 * exists to reap. Both are corrected here, and the relationship is recorded as
 * data so the reasoning cannot be re-derived by guess.
 */
export const CROSS_TENANT_BY_DESIGN: readonly CrossTenantRelation[] = [
  {
    table: "skills",
    column: "installed_from_skill_id",
    parent: "skills",
    reason:
      "marketplace PROVENANCE, not ownership: installing a public skill clones it " +
      "and points at the ORIGINAL, whose tenant is by design someone else's.",
    reads: "scoped-read",
  },
  {
    table: "tool_packages",
    column: "installed_from_tool_package_id",
    parent: "tool_packages",
    reason: "marketplace PROVENANCE — same as skills.installed_from_skill_id.",
    reads: "scoped-read",
  },
  {
    table: "runs",
    column: "runner_id",
    parent: "runners",
    reason:
      "runners are SHARED ACROSS TENANTS. A runner registers under one tenant " +
      "(api/runners/register) but the claim route stamps runs.runner_id keyed only " +
      "on (run id, runner_id IS NULL) with NO tenant filter — so a runner " +
      "legitimately executes another tenant's run. Prod confirms it: one runner " +
      "served all 3 tenants, 8 runs carry tenant_id != runners.tenant_id, all old " +
      "and terminal. A trigger here REJECTS a legitimate claim and wedges the run.",
    reads: "platform-internal",
  },
  {
    table: "dev_server_sessions",
    column: "runner_id",
    parent: "runners",
    reason:
      "same shared-runner relationship as runs.runner_id — a dev-server session " +
      "runs on whichever runner owns the workspace host, not on one of its own " +
      "tenant's.",
    reads: "platform-internal",
  },
];

/** Is this (table, column) cross-tenant by design? */
export function isCrossTenantByDesign(table: string, column: string): boolean {
  return CROSS_TENANT_BY_DESIGN.some((p) => p.table === table && p.column === column);
}

/** PostgREST calls that constitute a real filter (as opposed to a projection). */
const FILTER_CALLS = ["eq", "in", "filter", "match", "or", "is", "neq", "contains"] as const;

export type FromChain = {
  table: string;
  /** The identifier the `.from(` was called on, e.g. `supabase` in `supabase.from(…)`. */
  receiver: string;
  /** The chained calls belonging to THIS `.from(...)`, source text. */
  chain: string;
  /** 1-based line of the `.from(` call. */
  line: number;
};

/**
 * Extract every `.from("table")` call in `src` together with ITS OWN chain.
 *
 * Walks the chain by balancing parens rather than scanning to a delimiter, so a
 * `.from` nested inside a `Promise.all([...])` array element captures only its
 * own calls and its siblings are parsed independently. This is blind spot (a)
 * from the header, fixed.
 */
export function parseFromChains(src: string): FromChain[] {
  const out: FromChain[] = [];
  // Capture the receiver too: `supabase.from("x")`, `deps.db.from("x")`, and —
  // critically — the multi-line form the codebase actually uses:
  //
  //     await supabase
  //       .from("runs")
  //
  // A receiver pattern that forbids whitespace before `.from` silently MISSES
  // every one of those. That is not a cosmetic bug: it is the same
  // false-negative failure mode that made the previous detector useless, and it
  // dropped the repo-wide count from 69 to 2 while looking like progress.
  const re = /([A-Za-z_$][\w$]*(?:\s*\.\s*[\w$]+)*)\s*\.\s*from\(\s*["'`](\w+)["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const receiver = m[1]!;
    const table = m[2]!;
    const chain = readChain(src, m.index + m[0].length);
    out.push({ receiver, table, chain, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

/**
 * Is `receiver` bound to an RLS-BOUND client in this file?
 *
 * The class needs an RLS-OFF client: where RLS applies, the database already
 * scopes the read and a `tenant_id` predicate adds nothing. Flagging those was
 * noise that would have pushed ~20 pointless filters into request paths.
 *
 * CONSERVATIVE BY CONSTRUCTION: this returns true ONLY for a binding it can see
 * assigned from `supabaseServer()` / a browser client. Anything else — a
 * service client, a DI'd parameter (`deps.db`), a client threaded through an
 * argument, an unrecognised shape — is treated as RLS-OFF and gets flagged. The
 * previous detector died of a cheerful assumption; this one only ever guesses in
 * the direction that produces MORE work, never less.
 */
export function isRlsBoundReceiver(src: string, receiver: string): boolean {
  const name = receiver.split(".")[0]!;
  // `const supabase = await supabaseServer()` / `= supabaseBrowser()` / `= createBrowserClient(`
  const rls = new RegExp(
    `\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:await\\s+)?(?:supabaseServer|supabaseBrowser|createBrowserClient)\\s*\\(`,
  );
  if (!rls.test(src)) return false;
  // If the same identifier is ALSO bound from a service client anywhere in the
  // file, we cannot tell which binding reaches this read — so we do not claim
  // it is safe.
  const svc = new RegExp(
    `\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:await\\s+)?supabaseService\\s*\\(`,
  );
  return !svc.test(src);
}

/**
 * From `pos`, consume the sequence of `.method(...)` calls chained onto the
 * preceding expression, and return their source text. Stops at the first thing
 * that is not a chained call — a `,`, `)`, `;`, `]`, or anything else — which is
 * exactly what keeps a `Promise.all` sibling out of this chain.
 */
function readChain(src: string, pos: number): string {
  const start = pos;
  let i = pos;
  for (;;) {
    // Skip whitespace and line comments between chained calls.
    while (i < src.length) {
      if (/\s/.test(src[i]!)) {
        i++;
        continue;
      }
      if (src.startsWith("//", i)) {
        const nl = src.indexOf("\n", i);
        if (nl === -1) return src.slice(start, i);
        i = nl + 1;
        continue;
      }
      break;
    }
    // A chained call looks like `.name(`.
    const rest = src.slice(i);
    const call = /^\.\s*(\w+)\s*\(/.exec(rest);
    if (!call) return src.slice(start, i);
    // Consume the balanced argument list.
    //
    // The scanner MUST skip comments, not just strings. An apostrophe in an
    // ordinary prose comment inside an argument list — `// inherit the original
    // run's runner kind`, in supervision.ts — otherwise opens a phantom string
    // that swallows everything up to the next quote. That is not cosmetic: the
    // chain then runs thousands of characters past its own call and absorbs
    // unrelated queries, which breaks the detector in BOTH directions. It
    // reported a fictional `runs`-by-`run_id` violation at the `.insert(…)` in
    // supervision.ts (the `.eq("run_id", …)` it "found" belonged to a later
    // `run_steps` query) — and, far worse, a chain that swallows a LATER
    // query's `.eq("tenant_id", …)` reads as SCOPED, hiding a real violation.
    // Blind spot (a) again, one level down.
    let depth = 0;
    let j = i + call[0].length - 1; // at the '('
    let inStr: string | null = null;
    for (; j < src.length; j++) {
      const c = src[j]!;
      if (inStr) {
        if (c === "\\") j++;
        else if (c === inStr) inStr = null;
        continue;
      }
      // `//` to end of line. (`a // b` is not valid JS, so a `//` here is
      // always a comment, never division.)
      if (src.startsWith("//", j)) {
        const nl = src.indexOf("\n", j);
        if (nl === -1) break;
        j = nl;
        continue;
      }
      if (src.startsWith("/*", j)) {
        const end = src.indexOf("*/", j + 2);
        if (end === -1) break;
        j = end + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= src.length) return src.slice(start);
    i = j + 1;
  }
}

/**
 * Does this chain carry a real `tenant_id` PREDICATE?
 *
 * Blind spot (b), fixed: a SELECTED `tenant_id` column is not a filter.
 * `.select("id, tenant_id, …")` must NOT count; `.eq("tenant_id", x)` must.
 */
export function hasTenantPredicate(chain: string): boolean {
  for (const call of FILTER_CALLS) {
    // `.eq("tenant_id", …)` / `.in("tenant_id", …)` / `.filter("tenant_id", …)`
    if (new RegExp(`\\.\\s*${call}\\(\\s*["'\`]tenant_id["'\`]`).test(chain)) return true;
  }
  // `.match({ tenant_id: … })`
  if (/\.\s*match\(\s*\{[^}]*\btenant_id\b/.test(chain)) return true;
  // `.or("tenant_id.eq.…")` — the tenant appears inside the or-expression.
  if (/\.\s*or\(\s*["'`][^"'`]*\btenant_id\b/.test(chain)) return true;
  return false;
}

/**
 * Which attacker pointers this chain FILTERS on (not merely selects).
 *
 * `pointers` is the SCHEMA-DERIVED vocabulary (`attackerPointersFromSchema`),
 * passed in rather than read from a module constant. The constant it replaced
 * was hand-maintained and omitted eight real FK pointer names, which made the
 * detector blind to real service-role reads such as `runs`-by-`replay_of_run_id`.
 * (`runner_id` was on that list too, but it turned out NOT to belong in the
 * vocabulary at all — see `CROSS_TENANT_BY_DESIGN`.)
 */
export function filteredPointers(chain: string, pointers: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const ptr of pointers) {
    for (const call of FILTER_CALLS) {
      if (new RegExp(`\\.\\s*${call}\\(\\s*["'\`]${ptr}["'\`]`).test(chain)) hits.add(ptr);
    }
    if (new RegExp(`\\.\\s*match\\(\\s*\\{[^}]*\\b${ptr}\\b`).test(chain)) hits.add(ptr);
  }
  return [...hits];
}

export type Violation = {
  file: string;
  line: number;
  table: string;
  pointers: string[];
};

export type ScanInput = {
  file: string;
  src: string;
};

/**
 * Find every read in the class.
 *
 * `tenantScopedTables` is DERIVED FROM THE SCHEMA by the caller, never
 * hand-listed — that is what makes "this table has no tenant_id, so it is
 * exempt" a checkable fact rather than the "the ids are already clean"
 * hand-wave that caused this class in the first place. A table absent from that
 * set has no `tenant_id` column and therefore cannot carry a conflicting tenant:
 * its rows are scoped purely by the parent they are keyed on.
 */
export function scanForUnscopedReads(
  inputs: readonly ScanInput[],
  tenantScopedTables: ReadonlySet<string>,
  attackerPointers: readonly string[],
  ignore?: (v: Violation) => boolean,
): Violation[] {
  const out: Violation[] = [];
  for (const { file, src } of inputs) {
    for (const { receiver, table, chain, line } of parseFromChains(src)) {
      if (!tenantScopedTables.has(table)) continue; // no tenant_id column at all
      // RLS already scopes it. Unknown receivers are NOT given this benefit.
      if (isRlsBoundReceiver(src, receiver)) continue;
      const pointers = filteredPointers(chain, attackerPointers);
      if (pointers.length === 0) continue;
      if (hasTenantPredicate(chain)) continue;
      const v: Violation = { file, line, table, pointers };
      if (ignore?.(v)) continue;
      out.push(v);
    }
  }
  return out;
}

// ─── Schema derivation ─────────────────────────────────────────────────────
//
// Both the detector's "does this table have a tenant_id?" question and the DB
// trigger's coverage test read the schema from the migrations rather than a
// hand-written list. A hand list is exactly what has already failed twice here:
// the round-3 trigger enumeration was written from memory and silently omitted
// `run_verifications`.

/** One column definition inside a `create table` body. */
type ColumnDef = { name: string; body: string };

/** Split a `create table (…)` body into its top-level column definitions. */
function splitColumns(body: string): ColumnDef[] {
  const out: ColumnDef[] = [];
  let depth = 0;
  let cur = "";
  for (const c of body) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    // A comma at depth 0 ends a column definition; inside `check (a, b)` it does not.
    if (c === "," && depth === 0) {
      out.push(toColumn(cur));
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(toColumn(cur));
  return out.filter((c) => c.name.length > 0);
}

function toColumn(text: string): ColumnDef {
  // A multi-column `alter table X add column a …, add column b …;` splits into
  // chunks that still carry their `add column [if not exists]` prefix; without
  // stripping it the column reads as being named "add".
  const t = text.trim().replace(/^add\s+column\s+(?:if\s+not\s+exists\s+)?/i, "");
  const m = /^(\w+)\b/.exec(t);
  return { name: m ? m[1]! : "", body: t };
}

/**
 * Strip SQL comments before parsing.
 *
 * Not cosmetic: these migrations are heavily commented, and prose inside a
 * `-- …` line contains words like "the" followed later by "references
 * public.agents". Parsing the raw text invented columns named `the` and `add`.
 * A schema enumeration that hallucinates columns cannot drive a schema guard.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Every `create table` body in these sources, keyed by table name. */
function tableBodies(sqlSources: readonly string[]): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const raw of sqlSources) {
    const sql = stripSqlComments(raw);
    const lower = sql.toLowerCase();
    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(lower))) {
      const name = m[1]!;
      let depth = 0;
      let i = m.index + m[0].length - 1;
      for (; i < lower.length; i++) {
        const c = lower[i]!;
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      const inner = lower.slice(m.index + m[0].length, i);
      bodies.set(name, (bodies.get(name) ?? "") + "," + inner);
    }
    // Columns added later.
    const alterRe =
      /alter\s+table\s+(?:public\.)?(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([\s\S]*?);/g;
    while ((m = alterRe.exec(lower))) {
      bodies.set(m[1]!, (bodies.get(m[1]!) ?? "") + "," + m[2]!);
    }
  }
  return bodies;
}

/**
 * Tables that HAVE a `tenant_id` column — i.e. tables whose rows can carry a
 * tenant that DISAGREES with the parent they point at. A table absent from this
 * set is scoped purely by its parent and needs no predicate of its own.
 */
export function tenantScopedTablesFromMigrations(sqlSources: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const [table, body] of tableBodies(sqlSources)) {
    if (splitColumns(body).some((c) => c.name === "tenant_id" && /\buuid\b/.test(c.body))) {
      out.add(table);
    }
  }
  return out;
}

/**
 * Every (table with `tenant_id`) × (FK column naming another tenant-scoped
 * table) pair — the complete set the DB trigger must cover.
 *
 * Parsed COLUMN BY COLUMN, not with a regex over the whole body: a body-wide
 * `(\w+)\s+uuid[^,]*references public.projects` happily matches across a comma
 * and invented `tickets.fan_out_group -> projects`, which is a plain uuid and no
 * FK at all. An enumeration that drives a schema guard has to be exact, or the
 * guard inherits its holes.
 */
export function tenantPointersFromMigrations(sqlSources: readonly string[]): TenantPointer[] {
  const tenantTables = tenantScopedTablesFromMigrations(sqlSources);
  const out: TenantPointer[] = [];
  const seen = new Set<string>();
  for (const [table, body] of tableBodies(sqlSources)) {
    if (!tenantTables.has(table)) continue;
    for (const col of splitColumns(body)) {
      if (col.name === "tenant_id") continue;
      if (!/\buuid\b/.test(col.body)) continue;
      const ref = /references\s+(?:public\.)?(\w+)\s*\(/.exec(col.body);
      if (!ref) continue;
      const parent = ref[1]!;
      // Only parents that are themselves tenant-scoped can disagree about tenancy.
      if (!tenantTables.has(parent)) continue;
      const key = `${table}.${col.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ table, column: col.name, parent });
    }
  }
  return out.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

/**
 * THE single source of truth: every tenant→parent pointer in the schema —
 * FK-derived plus the curated non-FK ones.
 *
 * Both guard layers consume this. The triggers are generated from it, and the
 * detector's pointer vocabulary is derived from it, so the two cannot drift.
 * They previously did: `ATTACKER_POINTERS` was hand-maintained and omitted eight
 * FK pointer names (`assignee_agent_id`, `committed_ticket_id`, `kb_id`,
 * `merger_ticket_id`, `pending_push_id`, `replay_of_run_id`, `runner_id`,
 * `schedule_id`), which made the detector blind to real service-role reads such
 * as `replay` reading runs by `replay_of_run_id`. A hand list next to a derived
 * list is a drift bug waiting.
 *
 * This is the RAW relationship set — it still contains the cross-tenant-by-design
 * pointers. Use `guardedTenantPointers` for "what the invariant must enforce";
 * enumerating from this one directly is what produced the shared-runner triggers.
 */
export function allTenantPointers(sqlSources: readonly string[]): TenantPointer[] {
  const fk = tenantPointersFromMigrations(sqlSources);
  const seen = new Set(fk.map((p) => `${p.table}.${p.column}`));
  const merged = [...fk];
  for (const p of NON_FK_TENANT_POINTERS) {
    if (seen.has(`${p.table}.${p.column}`)) continue;
    merged.push(p);
  }
  return merged.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

/**
 * The pointers the tenant-matches-parent invariant actually GUARDS: every
 * relationship in the schema, minus the ones that are cross-tenant by design.
 *
 * This is the set the DB triggers must cover and the prod audit must check. It
 * is deliberately a separate function from `allTenantPointers` rather than a
 * filter applied at each call site: the exclusions had been re-stated by hand in
 * the coverage test, the migration and the audit, which is how a wrong one
 * (`runner_id`) could be enforced in two places and questioned in none.
 */
export function guardedTenantPointers(sqlSources: readonly string[]): TenantPointer[] {
  return allTenantPointers(sqlSources).filter((p) => !isCrossTenantByDesign(p.table, p.column));
}

/**
 * Column names that are exclusively PLATFORM-INTERNAL join keys — every
 * relationship using them is cross-tenant by design AND has no owning tenant to
 * scope a read to.
 *
 * A read keyed on one of these must NOT carry `.eq("tenant_id", …)`: the
 * runner-watchdog reaping a dead runner's runs has to see every tenant's runs on
 * that runner, or the cross-tenant ones are never reaped and hang forever. So
 * the detector must not flag them — flagging demands a "fix" that is the bug.
 *
 * Computed, not typed: a column drops out only when EVERY pair using it is
 * platform-internal. Provenance columns stay IN the vocabulary, because a
 * provenance read does have an owning tenant ("which of MY skills came from X")
 * and should still be scoped.
 */
export function platformInternalPointerColumns(): string[] {
  const byColumn = new Map<string, CrossTenantRelation[]>();
  for (const p of CROSS_TENANT_BY_DESIGN) {
    byColumn.set(p.column, [...(byColumn.get(p.column) ?? []), p]);
  }
  return [...byColumn.entries()]
    .filter(([, rels]) => rels.every((r) => r.reads === "platform-internal"))
    .map(([column]) => column)
    .sort();
}

/**
 * The detector's pointer vocabulary, DERIVED from the schema rather than typed
 * out. Every column name that any tenant-scoped table uses to name a
 * tenant-scoped parent is a name an attacker can aim at one of our rows —
 * EXCEPT the platform-internal join keys above, where a tenant predicate is not
 * a hardening but a bug.
 */
export function attackerPointersFromSchema(sqlSources: readonly string[]): string[] {
  const platformInternal = new Set(platformInternalPointerColumns());
  return [
    ...new Set(
      allTenantPointers(sqlSources)
        .map((p) => p.column)
        .filter((c) => !platformInternal.has(c)),
    ),
  ].sort();
}
