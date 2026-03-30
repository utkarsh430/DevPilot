// Upstash Redis client (REST-based, edge-safe). Lazy-instantiated so importing
// this file in code paths that never touch Redis doesn't crash on missing env.
//
// INSTANCE-level secret (the shared job queue + locks; there is no tenant here):
// the url+token resolve through the platform-secrets resolver at the instance
// scope (tenantId:null) with env as the final fallback. The client is memoized
// by the RESOLVED (url, token) PAIR — exactly like lib/llm/models-tenant.ts keys
// its Anthropic clients by the resolved key value — so rotating either value in
// the UI rebuilds the client on the next call (a different pair → memo miss).
//
// env-ALWAYS fallback: `resolveSync` returns env on a cold/stale cache or when
// the feature flag is off, so the very first call here is byte-for-byte today's
// behavior with no explicit warm-up needed. If neither the DB nor env resolves,
// `env.UPSTASH_*` throws the same "Missing required env var" as before.

import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
import { resolveSync } from "@/lib/platform-secrets/resolver";

let _client: Redis | null = null;
let _key: string | null = null;

export function redis(): Redis {
  // Instance scope (tenantId:null). resolveSync falls back to env on a cold
  // cache / flag-off, so cold === today. `env.UPSTASH_*` is the hard fallback
  // and throws if even env is unset — same as before.
  const url =
    resolveSync("UPSTASH_REDIS_REST_URL", { tenantId: null }) ?? env.UPSTASH_REDIS_REST_URL;
  const token =
    resolveSync("UPSTASH_REDIS_REST_TOKEN", { tenantId: null }) ?? env.UPSTASH_REDIS_REST_TOKEN;

  // Value-keyed memo: rebuild only when the resolved pair changes (rotation).
  const memoKey = `${url}\u0000${token}`;
  if (_client && _key === memoKey) return _client;
  _client = new Redis({ url, token });
  _key = memoKey;
  return _client;
}
