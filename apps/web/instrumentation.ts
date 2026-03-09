// Server-boot hook (Next.js instrumentation). On an UNCONFIGURED instance this
// prints the one-time /setup token banner to the console so the operator's very
// first `pnpm --filter web dev` tells them where to go. A configured instance
// boots silently — the setup surface is dead code for it.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // FIRST, before anything else touches env: mirror any legacy `ACE_*` var onto
  // its `DEVPILOT_*` name, so an operator's un-migrated `.env.local` keeps
  // working. `register()` runs on server boot, ahead of every route module, so
  // module-scope env reads downstream see the mirrored values. Transitional —
  // see lib/env/legacy-alias.ts.
  await import("./lib/env/legacy-alias");
  // Serverless hosts skip the banner: the setup token is bypassed there (the
  // wizard degrades to read-only copy-paste guidance). Checked via raw env -
  // lib/setup/env-file can't be imported here (node:fs breaks the edge bundle
  // this file is also compiled for, even behind the runtime guard above).
  if (process.env.VERCEL) return;
  const { isBootConfigured } = await import("./lib/setup/boot-status");
  if (isBootConfigured()) return;
  const { printSetupBannerOnce } = await import("./lib/setup/setup-token");
  printSetupBannerOnce();
}
