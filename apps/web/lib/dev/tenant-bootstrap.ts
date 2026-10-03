// Creating the first sign-in account on a LOCAL Supabase, so the runner has a
// tenant to bind to before anyone has opened the app — the pure half of that
// step in `scripts/setup-local.mjs`.
//
// The chicken-and-egg this closes: `apps/runner/src/env.ts` refuses to boot
// without `DEVPILOT_RUNNER_TENANT_ID`, and a tenant exists only once a user
// does (`handle_new_user` mints a personal tenant on `auth.users` insert, see
// `supabase/migrations/20260615000000_drop_default_project.sql`). So setup
// asks which email the operator will sign in with, creates that user through
// GoTrue's admin API, and reads the tenant the trigger produced. Signing in
// later with the same email lands in that tenant; the runner is already its.
//
// Nothing here is a security boundary: the admin endpoint is reached with the
// local stack's own secret key, against a database on the operator's machine.
// The script refuses to run it against anything but a loopback host.

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** `POST /auth/v1/admin/users` — the request GoTrue's admin API expects.
 *  `email_confirm: true` so the magic link is the only step left. */
export function adminCreateUserRequest(
  apiUrl: string,
  secretKey: string,
  email: string,
): { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } } {
  return {
    url: `${apiUrl.replace(/\/+$/, "")}/auth/v1/admin/users`,
    init: {
      method: "POST",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: email.trim(), email_confirm: true }),
    },
  };
}

export type AdminCreateUserOutcome = "created" | "exists" | { error: string };

/** 200/201 → created. 422 with GoTrue's "already registered" shape → exists
 *  (a re-run of setup, which must be a no-op). Anything else is an error that
 *  carries the body, because "HTTP 500" alone sends nobody anywhere. */
export function interpretAdminCreateUser(status: number, body: unknown): AdminCreateUserOutcome {
  if (status === 200 || status === 201) return "created";
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const msg = String(obj.msg ?? obj.message ?? obj.error_description ?? obj.error ?? "");
  if (
    status === 422 &&
    (obj.error_code === "email_exists" || /already (been )?registered|already exists/i.test(msg))
  ) {
    return "exists";
  }
  const detail = msg || (typeof body === "string" ? body : JSON.stringify(body ?? null));
  return { error: `GoTrue admin/users returned HTTP ${status}: ${detail}` };
}

/** The tenant the trigger made this user an owner of. Ordered by the tenant's
 *  own `created_at` so an account that later joins other workspaces still
 *  resolves to its original one. Filtered to owner/admin because a runner
 *  bound to a tenant the user merely belongs to would confuse "my runner is
 *  offline" with "someone else's runner is offline". */
export const OWNER_TENANT_FOR_EMAIL_SQL = `
  select t.id, t.name
    from public.tenant_members m
    join public.tenants t on t.id = m.tenant_id
    join auth.users u on u.id = m.user_id
   where lower(u.email) = lower($1)
     and m.role in ('owner', 'admin')
   order by t.created_at asc
   limit 1
`;

/** The install's "instance operator" is an owner/admin of the OLDEST tenant
 *  (`lib/platform-secrets/operator.ts`). Read it so setup can say, up front,
 *  whether the account it just created will see Settings → Setup. */
export const OLDEST_TENANT_SQL = `
  select id, name
    from public.tenants
   order by created_at asc
   limit 1
`;

export type TenantRef = { id: string; name: string };

/** Same tenant (or no other tenant) → operator. A different, older tenant —
 *  typically the guide fixture seeded by an earlier `supabase start` — means
 *  the instance-wide settings pages are hidden for this account, which is
 *  worth saying before the operator goes looking for them. */
export function classifyOperator(
  oldest: TenantRef | null,
  mine: TenantRef,
): { operator: boolean; reason: string } {
  if (oldest === null || oldest.id === mine.id) {
    return { operator: true, reason: `"${mine.name}" is the oldest tenant on this database` };
  }
  return {
    operator: false,
    reason:
      `"${mine.name}" is not the oldest tenant on this database ("${oldest.name}" is), so ` +
      "Settings → Setup and runner-credential generation are hidden for this account. " +
      "If this local database is disposable: supabase db reset && pnpm setup:local --email <you>",
  };
}
