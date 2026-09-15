import "server-only";

// The IO half of env-var reconciliation: gather the three inputs, hand them to
// the pure `planEnvPush`, and — on a separate, human-confirmed call — execute it.
//
// ── The split is the safety property, not a style choice ───────────────────
// `buildEnvPushPlan` performs NO write. `executeEnvPush` re-derives the plan from
// scratch rather than accepting one from the browser. So the plan the operator
// confirms is advisory to the server, and a forged plan posted straight to the
// action cannot cause a variable to be pushed that the server would not have
// chosen on its own. The only thing the browser contributes is the `overrides`
// list, and by construction (see `planEnvPush`) an override can only promote a
// key that is ALREADY declared-and-held from `leave` to `push` — it can never
// manufacture one.
//
// ── Secret values in this file ─────────────────────────────────────────────
// Exactly one function reads plaintext (`executeEnvPush`, via `getProjectSecret`)
// and it hands each value straight to `pushVercelEnvVar`. No value is returned,
// logged, put in an error message, or held past the loop iteration. Every result
// type below carries KEY NAMES only. If a change here needs a value to escape
// this file, it is wrong.

import {
  getProjectSecret,
  listProjectSecretNames,
  loadProjectEnvCatalog,
} from "@/lib/projects/secrets";
import { listVercelProjectEnv, pushVercelEnvVar, type VercelClientOptions } from "@/lib/vercel/api";
import { VercelApiError } from "@/lib/vercel/errors";
import {
  ENV_PUSH_TARGETS,
  isDevPilotManaged,
  planEnvPush,
  type EnvPushPlan,
  type RemoteEnvVar,
} from "@/lib/vercel/env-plan";

export type BuildEnvPushPlanResult =
  | { ok: true; plan: EnvPushPlan; remoteReadFailed: false }
  | {
      ok: true;
      plan: EnvPushPlan;
      /** Vercel could not be read. The plan is still produced (from catalog +
       *  vault) but every declared-and-held key looks absent, so it reads as
       *  "create". That is the SAFE direction — `?upsert=true` makes a redundant
       *  create idempotent — but the operator is told, because a plan that
       *  silently omits the "already set on Vercel" column is a plan that looks
       *  like it checked and did not. */
      remoteReadFailed: true;
      remoteError: string;
    }
  | { ok: false; error: string };

/**
 * Assemble the three-way plan. Read-only.
 *
 * `tenantId` is threaded into every read. `listProjectSecretNames` and
 * `loadProjectEnvCatalog` are both service-role and both keyed on a
 * caller-supplied `projectId`, so their co-located `.eq("tenant_id", …)` is the
 * boundary: without it, a forged id would let one tenant enumerate another's
 * declared variable names and vault key names through this action's result.
 */
export async function buildEnvPushPlan(args: {
  tenantId: string;
  projectId: string;
  vercelProjectId: string;
  overrides?: string[];
  opts: VercelClientOptions;
}): Promise<BuildEnvPushPlanResult> {
  const [catalog, vaultNames] = await Promise.all([
    loadProjectEnvCatalog(args.projectId, args.tenantId),
    listProjectSecretNames(args.projectId, args.tenantId),
  ]);
  const vaultKeys = vaultNames.map((n) => n.secretKey);

  let remote: RemoteEnvVar[] = [];
  let remoteError: string | null = null;
  try {
    const live = await listVercelProjectEnv(args.vercelProjectId, args.opts);
    remote = await Promise.all(
      live.map(async (e) => ({
        key: e.key,
        id: e.id,
        targets: e.target,
        managedByDevPilot: isDevPilotManaged(e.comment),
        valueMatchesVault: await compareWithVault({
          tenantId: args.tenantId,
          projectId: args.projectId,
          key: e.key,
          remoteValue: e.value,
          held: vaultKeys.includes(e.key),
        }),
      })),
    );
  } catch (err) {
    remoteError =
      err instanceof VercelApiError
        ? err.message
        : "Could not read this project's environment variables from Vercel.";
  }

  const plan = planEnvPush({
    catalog: catalog.map((c) => ({
      key: c.key,
      required: c.required,
      description: c.description,
    })),
    vaultKeys,
    remote,
    overrides: args.overrides,
    targets: ENV_PUSH_TARGETS,
  });

  return remoteError === null
    ? { ok: true, plan, remoteReadFailed: false }
    : { ok: true, plan, remoteReadFailed: true, remoteError };
}

/**
 * Can we tell whether Vercel's copy already matches ours?
 *
 * Almost always NO, and that is by design: DevPilot writes `type: "sensitive"`,
 * which Vercel makes non-readable, so the list endpoint returns no value. The
 * comparison is possible only for a `plain` variable somebody else created — and
 * for that case answering honestly is worth the read, because "already correct"
 * and "someone else's different value" deserve opposite treatment.
 *
 * Returns `null` for "could not tell". Never guess `true`.
 */
async function compareWithVault(args: {
  tenantId: string;
  projectId: string;
  key: string;
  remoteValue: string | null;
  held: boolean;
}): Promise<boolean | null> {
  if (args.remoteValue === null || !args.held) return null;
  const ours = await getProjectSecret(args.projectId, args.key, args.tenantId);
  if (ours === null) return null;
  return ours === args.remoteValue;
}

export type EnvPushOutcome = {
  /** Keys written to Vercel. */
  pushed: string[];
  /** Keys that failed, with the (already-scrubbed) reason. NEVER a value. */
  failed: { key: string; error: string }[];
};

/**
 * Execute the push.
 *
 * Re-derives the plan server-side (see the header) and pushes only what THAT
 * plan says. Continues past a failure rather than aborting: with eight variables
 * a mid-list failure that rolled nothing back and reported nothing would leave
 * the operator unable to tell which half landed. `?upsert=true` makes the retry
 * of a partially-completed push safe.
 */
export async function executeEnvPush(args: {
  tenantId: string;
  projectId: string;
  vercelProjectId: string;
  overrides?: string[];
  opts: VercelClientOptions;
}): Promise<{ ok: true; outcome: EnvPushOutcome } | { ok: false; error: string }> {
  const built = await buildEnvPushPlan(args);
  if (!built.ok) return built;

  const outcome: EnvPushOutcome = { pushed: [], failed: [] };

  for (const item of built.plan.push) {
    const value = await getProjectSecret(args.projectId, item.key, args.tenantId);
    if (value === null) {
      // The plan said we hold it; the read says otherwise. Almost always a
      // missing/rotated SECRETS_ENCRYPTION_KEY, which `getProjectSecret`
      // tolerates by returning null. Pushing an empty string here would be the
      // worst outcome available — a variable that exists, looks configured, and
      // breaks the deploy — so it is reported instead.
      outcome.failed.push({
        key: item.key,
        error: "DevPilot could not decrypt the stored value (check SECRETS_ENCRYPTION_KEY).",
      });
      continue;
    }
    try {
      await pushVercelEnvVar(
        {
          projectId: args.vercelProjectId,
          key: item.key,
          value,
          targets: item.targets,
        },
        args.opts,
      );
      outcome.pushed.push(item.key);
    } catch (err) {
      outcome.failed.push({
        key: item.key,
        // `VercelApiError.message` has already been through `scrubSecrets`.
        // Anything else is replaced with a fixed string rather than
        // `String(err)`, because an arbitrary throw from the fetch layer can
        // echo request context and this request's body is the secret.
        error:
          err instanceof VercelApiError ? err.message : "Vercel rejected the variable (no detail).",
      });
    }
  }

  return { ok: true, outcome };
}
