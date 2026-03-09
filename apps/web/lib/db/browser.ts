"use client";

import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

export function supabaseBrowser() {
  return createBrowserClient(publicEnv.SUPABASE_URL, publicEnv.SUPABASE_PUBLISHABLE_KEY);
}
