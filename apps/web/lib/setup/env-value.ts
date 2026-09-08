// How a value is written into `apps/web/.env.local` — ONE rule, shared by the
// in-app writer (`env-file.ts`, behind `server-only`) and the clone-time
// bootstrap (`scripts/setup-local.mjs`, plain Node). The two must agree, or a
// value the wizard would refuse could be written by the script and then read
// differently by the two loaders it exists to keep in sync.
//
// No `server-only` here on purpose: this file is the half that a script can
// import. It touches nothing but strings.

export function serializeEnvValue(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Value must be a single line");
  }
  // No .env.local encoding of `$` survives BOTH loaders: @next/env
  // (dotenv-expand) interpolates $X in every quoting form unless written as
  // \$, while the runner's `node --env-file` keeps that backslash literally.
  // Refuse rather than silently store a value the two processes would read
  // differently.
  if (/\$/.test(value)) {
    throw new Error(
      'Value contains "$", which .env.local can\'t store faithfully (Next expands $VAR, the runner\'s --env-file doesn\'t). Use a value without "$".',
    );
  }
  // Quote when the raw form would be ambiguous to dotenv parsing.
  if (/[\s#'"]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
