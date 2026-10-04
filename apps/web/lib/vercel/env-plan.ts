// The env-var reconciliation decision: which variables DevPilot pushes to Vercel,
// which it must ask a human for, and which it deliberately leaves alone.
//
// Pure. No fetch, no server-only, no DB — and, load-bearing, **no secret values**.
// The caller resolves everything down to booleans before calling in; see
// `RemoteEnvVar.valueMatchesVault`. A plan object is rendered in the browser and
// may end up in a log line, so the type system is what guarantees a value cannot
// be in it: there is no field of this module's output that can hold one.
//
// ── Where the source of truth lives, and why it is not the repo ────────────
// The list of variables a project needs comes from `projects.env_catalog`, which
// the runner parses out of the repo's `.env.example`. That file is editable by
// agents. So it is treated as UNTRUSTED INPUT (principle 6): it PROPOSES a name,
// it never AUTHORISES a push.
//
// The property that makes that safe is the intersection below. DevPilot only ever
// pushes `declared ∩ held` — a name the repo declares AND a value a human has
// already stored in this project's vault. An agent that adds a line to
// `.env.example` therefore cannot cause any value to be sent to Vercel. The most
// it can do is add a NAME to the "DevPilot needs this" list, which a human then
// has to fill in by hand, having read it. That is the whole reduction: the
// untrusted input's blast radius is one row in a list a person reads.
//
// A name that DevPilot has never seen before — not in the vault, not already on
// Vercel — is flagged `firstSeen` so the UI can lift it out of a long list
// rather than bury it. A newly appeared name that is silently pushed is the
// failure mode this feature has to avoid; a newly appeared name that is
// *conspicuous* is working as intended.
//
// ── What happens to a value that already exists on Vercel ─────────────────
// DevPilot cannot read it back. `type: "sensitive"` variables are non-readable by
// design (that is why we write them), and `encrypted` ones are not returned in
// the list either. So "the value on Vercel differs from the vault" is, for
// anything that matters, NOT OBSERVABLE — and a policy written as though it were
// would be a lie. The observable proxy is PROVENANCE:
//
//   • DevPilot wrote it (our `comment` marker)  → ours to update. Push.
//   • Somebody else wrote it (no marker)       → LEAVE IT. Surface it, with an
//                                                explicit per-key opt-in to
//                                                overwrite, defaulted off.
//
// Silently overwriting an operator-set production value is a bad surprise, and
// the one case where we CAN compare (a `plain` variable whose value the API does
// return) is handled honestly too: equal means nothing to do, different means
// conflict. `valueMatchesVault: null` means "could not tell", and it is treated
// as conflict, never as equal.

/** The Vercel deployment targets DevPilot writes.
 *
 *  `development` is deliberately absent: it is a local concern already served by
 *  the runner writing `.env.local` into the workspace, and `type: "sensitive"`
 *  is only valid for `production`/`preview` — including development would force
 *  a weaker type for no benefit. */
export const ENV_PUSH_TARGETS = ["production", "preview"] as const;
export type EnvPushTarget = (typeof ENV_PUSH_TARGETS)[number];

/** Written into the Vercel env var's `comment` field on every push. This is the
 *  provenance marker the differing-value policy above turns on.
 *
 *  Fail direction if Vercel ever rejects or drops `comment`: the marker is
 *  absent, so every variable reads as foreign, so DevPilot leaves them alone and
 *  asks the operator to tick an overwrite box. That costs a click; it never
 *  costs an unwanted overwrite. */
export const DEVPILOT_ENV_COMMENT = "Managed by DevPilot";

export function isDevPilotManaged(comment: string | null | undefined): boolean {
  return (comment ?? "").trim().toLowerCase().startsWith(DEVPILOT_ENV_COMMENT.toLowerCase());
}

/** One variable as it exists on Vercel today, reduced to what the decision needs.
 *  Note there is no `value` field, by construction. */
export type RemoteEnvVar = {
  key: string;
  /** Vercel's own id — carried through so a caller could target the record
   *  directly; the push path uses `?upsert=true` and does not need it. */
  id: string | null;
  targets: string[];
  /** Did DevPilot write this? Derived from the `comment` marker. */
  managedByDevPilot: boolean;
  /**
   * Three states, not two. `true`/`false` only when the API actually returned a
   * comparable value (a `plain` variable); `null` whenever it did not — which is
   * the normal case, because we write `sensitive`.
   *
   * `null` must never be inferred to `true`. Reading "I could not check" as "it
   * matches" would let a stale or hostile production value survive a push the
   * operator believed had replaced it.
   */
  valueMatchesVault: boolean | null;
};

export type EnvCatalogInput = {
  key: string;
  required: boolean;
  description?: string | null;
};

/** A variable DevPilot will write to Vercel. */
export type EnvPushItem = {
  key: string;
  required: boolean;
  /** Why it is being pushed — rendered verbatim-ish by the UI so the operator
   *  can see that an overwrite is an overwrite. */
  reason: "create" | "update_managed" | "extend_targets" | "operator_override";
  /** Targets the variable will end up on after the upsert. */
  targets: EnvPushTarget[];
};

/** A variable the repo declares that DevPilot holds no value for. */
export type EnvAskItem = {
  key: string;
  required: boolean;
  description: string | null;
  /**
   * DevPilot has never seen this name: not in the vault, not on Vercel.
   *
   * This is exactly the class an edited `.env.example` can conjure, so it is
   * called out rather than merged into the list. A first-seen name is not
   * refused — a genuinely new dependency looks identical — but it is never
   * quiet.
   */
  firstSeen: boolean;
};

/** A declared variable already present on Vercel that DevPilot will NOT touch. */
export type EnvLeaveItem = {
  key: string;
  /** `identical` — we could compare and it already matches, so a push is a no-op.
   *  `foreign_unreadable` — somebody else set it and we cannot read it back.
   *  `foreign_differs` — somebody else set it and it demonstrably differs. */
  reason: "identical" | "foreign_unreadable" | "foreign_differs";
  /** Can the operator tick "overwrite" for this one? False for `identical`,
   *  where there is nothing to overwrite. */
  overridable: boolean;
};

export type EnvPushPlan = {
  push: EnvPushItem[];
  ask: EnvAskItem[];
  leave: EnvLeaveItem[];
  /**
   * Held in the vault but NOT declared by the repo. Never pushed.
   *
   * The vault legitimately holds runner-only keys, and widening a deployed app's
   * environment with them would be a silent expansion of what the deployed code
   * can reach. Reported so the operator can add one deliberately elsewhere; not
   * offered as a checkbox here, because "push everything" is precisely the habit
   * that makes the declared-list gate meaningless.
   */
  extra: string[];
  /** True when nothing at all would be written. */
  empty: boolean;
};

export type PlanEnvPushInput = {
  /** From `projects.env_catalog` — the repo's `.env.example`. UNTRUSTED. */
  catalog: EnvCatalogInput[];
  /** Names only, from the per-project vault. Never values. */
  vaultKeys: string[];
  /** What Vercel has today. */
  remote: RemoteEnvVar[];
  /** Keys the operator has explicitly ticked to overwrite. Only ever promotes a
   *  `leave` entry to a `push`; it can never manufacture a push for a key that
   *  is not declared-and-held, so a forged list widens nothing. */
  overrides?: string[];
  /** Defaults to production + preview. */
  targets?: readonly EnvPushTarget[];
};

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * Decide the three-way plan.
 *
 * Total and deterministic: every declared key lands in exactly one of
 * `push` / `ask` / `leave`, and the output is sorted so two runs over the same
 * inputs render identically (an operator comparing a plan against the one they
 * confirmed a minute ago should not have to diff a shuffled list).
 */
export function planEnvPush(input: PlanEnvPushInput): EnvPushPlan {
  const targets = [...(input.targets ?? ENV_PUSH_TARGETS)];
  const held = new Set(input.vaultKeys);
  const overrides = new Set(input.overrides ?? []);

  const remoteByKey = new Map<string, RemoteEnvVar>();
  for (const r of input.remote) remoteByKey.set(r.key, r);

  const push: EnvPushItem[] = [];
  const ask: EnvAskItem[] = [];
  const leave: EnvLeaveItem[] = [];

  // Dedupe the catalog by key: `.env.example` is a text file and a repeated line
  // is a plausible edit. Keep the strictest `required` seen for a name.
  const declared = new Map<string, EnvCatalogInput>();
  for (const entry of input.catalog) {
    const key = entry.key.trim();
    // A name that is not a legal env key cannot have come from a real
    // `.env.example` line and has no business in a Vercel request body. Dropped
    // rather than sanitised: silently rewriting an attacker-chosen name into a
    // legal one is how you push a variable nobody named.
    if (!ENV_KEY_RE.test(key)) continue;
    const prior = declared.get(key);
    declared.set(key, {
      key,
      required: (prior?.required ?? false) || entry.required,
      description: entry.description ?? prior?.description ?? null,
    });
  }

  for (const entry of [...declared.values()].sort(byKey)) {
    const key = entry.key;
    const remote = remoteByKey.get(key);

    if (!held.has(key)) {
      ask.push({
        key,
        required: entry.required,
        description: entry.description ?? null,
        firstSeen: remote === undefined,
      });
      continue;
    }

    if (!remote) {
      push.push({ key, required: entry.required, reason: "create", targets });
      continue;
    }

    if (remote.managedByDevPilot) {
      // Ours. Re-pushing is how a rotated vault value reaches production, and
      // `?upsert=true` makes it idempotent, so this is unconditional rather than
      // conditional on a comparison we usually cannot make.
      const covers = targets.every((t) => remote.targets.includes(t));
      push.push({
        key,
        required: entry.required,
        reason: covers ? "update_managed" : "extend_targets",
        targets,
      });
      continue;
    }

    // Foreign. Somebody set this on Vercel and it was not us.
    if (remote.valueMatchesVault === true) {
      // The one case we can prove is a no-op. Pushing would still be harmless,
      // but reporting it as a write when nothing changes trains the operator to
      // skim the plan.
      leave.push({ key, reason: "identical", overridable: false });
      continue;
    }
    if (overrides.has(key)) {
      push.push({ key, required: entry.required, reason: "operator_override", targets });
      continue;
    }
    leave.push({
      key,
      reason: remote.valueMatchesVault === false ? "foreign_differs" : "foreign_unreadable",
      overridable: true,
    });
  }

  const extra = input.vaultKeys.filter((k) => !declared.has(k)).sort();

  return {
    push: push.sort(byKey),
    ask: ask.sort(askOrder),
    leave: leave.sort(byKey),
    extra,
    empty: push.length === 0,
  };
}

function byKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Required first, then first-seen ahead of familiar, then alphabetical. The
 *  middle clause is the point: a name that appeared out of nowhere should be at
 *  the top of what the operator reads, not sorted into the middle of eight
 *  routine ones. */
function askOrder(a: EnvAskItem, b: EnvAskItem): number {
  if (a.required !== b.required) return a.required ? -1 : 1;
  if (a.firstSeen !== b.firstSeen) return a.firstSeen ? -1 : 1;
  return byKey(a, b);
}
