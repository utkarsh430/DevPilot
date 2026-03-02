// Thin internal wrapper around the auth provider. CLAUDE.md mandates this so
// the provider is swappable (Supabase Auth today, Clerk a possible future swap)
// without rippling through feature code.
//
// Feature code imports ONLY from "@/lib/auth", never from "@supabase/...".

import { cache } from "react";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/db/server";

// Note: browser-only auth helpers (e.g. `signInWithGithub`) live in
// `@/lib/auth/browser` so that "use client" components don't transitively
// import `supabaseServer` / `next/headers` from this file.

export type AuthUser = {
  id: string;
  email: string | null;
};

// React.cache: `auth.getUser()` is a real round trip to the Supabase auth
// server, and layout + page + nested loaders all ask for the same caller.
// Dedupe to one lookup per request; outside an RSC render cache() is a
// passthrough (each call runs the lookup, exactly as before).
export const getUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
});

export async function requireUser(): Promise<AuthUser> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Returns the tenant_id for the caller. Phase 0 assumes one tenant per user
 * (auto-provisioned by the handle_new_user() trigger). When multi-org lands
 * we'll switch this to read an active-tenant cookie or claim.
 */
export const getCurrentTenantId = cache(async (): Promise<string | null> => {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("tenant_members")
    .select("tenant_id")
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.tenant_id as string;
});

export async function requireTenantId(): Promise<string> {
  const tenantId = await getCurrentTenantId();
  if (!tenantId) redirect("/login");
  return tenantId;
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
}
