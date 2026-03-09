import { cache } from "react";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env, publicEnv } from "@/lib/env";

/**
 * RLS-bound Supabase client tied to the caller's session cookies.
 * Use for ALL request-scoped reads/writes that should respect tenant RLS.
 *
 * React.cache: one client per request — layout, page, and nested loaders that
 * each `await supabaseServer()` share a single instance (and its keep-alive
 * connection) instead of re-reading cookies and constructing a new client per
 * call. Outside an RSC render (route handlers, unit tests) cache() is a
 * passthrough and simply constructs a client per call, exactly as before.
 */
export const supabaseServer = cache(async () => {
  const cookieStore = await cookies();
  return createServerClient(publicEnv.SUPABASE_URL, publicEnv.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components can't write cookies; the middleware handles refresh.
        }
      },
    },
  });
});

/**
 * Service-role client. BYPASSES RLS. Use ONLY from server code that needs to
 * read/write across tenants — the durable engine, Inngest functions, and
 * runner-control routes. Never expose this to a browser-facing route.
 */
export function supabaseService() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
