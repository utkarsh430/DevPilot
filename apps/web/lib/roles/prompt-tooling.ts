// Verifiable TOOLING claims in role prompts.
//
// WHY THIS FILE EXISTS. A role prompt is trusted system-prompt text: whatever
// it asserts, the agent treats as true. So a prompt that names a tool the
// workspace does not have is not inert - the agent runs the command, gets an
// error, and (because the prompt said the tool was part of the stack) reads
// that error as a problem with the CODEBASE rather than with the instruction.
//
// That is not hypothetical. `qa_automation_engineer` and `sdet` both instructed
// `pnpm exec playwright test --reporter=line`, with "non-zero exit → fix before
// committing". No Playwright test runner is installed. The command does not
// fail cleanly: `playwright` resolves anyway (a transitive dependency of
// promptfoo), finds no Playwright config, scans the repo, collects the ~190
// Vitest files, and emits 171 errors of the form "Vitest cannot be imported in
// a CommonJS module" - each one naming a real, healthy test file - before
// ending with "No tests found" and exit 1. An agent obeying the prompt would
// have set about "fixing" a test suite that was never broken.
//
// SCOPE - deliberately ONLY `pnpm exec <bin>`, and the exclusions are the
// interesting part. Three candidate checks were prototyped and measured against
// all 53 roles before this one was chosen:
//
//   • "paths named in prompts must exist" - REJECTED, measured as noise.
//     100 path claims, 11 misses, and 7 of those 11 are correct as written:
//     `docs/adr/`, `docs/postmortems/`, `docs/threat-models/`, `docs/policies/`
//     are OUTPUT conventions whose whole point is that the role creates the
//     first file. A check that flags `software_architect` for writing the
//     repo's first ADR is a check people turn off.
//
//   • "`pnpm <script>` must exist in a package.json" - REJECTED, wrong target.
//     Roles run against ARBITRARY project repos (the runner clones
//     `projects.repo_url`, not this one), so `pnpm test` / `pnpm build` are
//     conventional script names, not assertions about this workspace.
//     Validating them against devpilot's own manifest tests the wrong repo.
//
//   • "`pnpm exec <bin>` must be a declared dependency" - KEPT. Unlike a script
//     name, a bare binary is never conventional: naming one is always a
//     concrete claim that a specific tool is installed. Extraction is anchored
//     on a literal `pnpm exec ` prefix, so there is no heuristic to tune, and
//     the whole repo claims exactly one such binary today.
//
// The check is on DECLARED dependencies, not on what happens to resolve.
// `playwright` resolves in `apps/web` purely because promptfoo depends on it -
// which is precisely how this defect stayed invisible, so treating "resolves"
// as "available" would reproduce the bug in the guard meant to catch it.

/** A `pnpm exec <bin> …` claim found in a prompt. */
export type ToolingClaim = {
  /** The binary the prompt says to run, e.g. `playwright`. */
  readonly bin: string;
  /** The full command as written, for the failure message. */
  readonly command: string;
};

/**
 * Every dependency name DIRECTLY declared by some workspace package. A
 * transitively-available binary is deliberately not a member - see the header.
 */
export type DeclaredDependencies = ReadonlySet<string>;

const PNPM_EXEC = /`\s*pnpm\s+exec\s+([^`\n]+)`/g;

/**
 * Role prompts are written as concatenated string literals, so a command can be
 * split across a `" +\n    "` boundary. Collapse those joins before matching, or
 * a command that straddles one is silently never checked.
 */
export function flattenPromptSource(source: string): string {
  return source.replace(/"\s*\+\s*\n\s*"/g, "");
}

/** Extract every `pnpm exec` claim from prompt text (or prompt source). */
export function extractToolingClaims(text: string): ToolingClaim[] {
  const claims: ToolingClaim[] = [];
  for (const match of flattenPromptSource(text).matchAll(PNPM_EXEC)) {
    const rest = (match[1] ?? "").replace(/\s+/g, " ").trim();
    const bin = rest.split(" ")[0];
    if (!bin) continue;
    claims.push({ bin, command: `pnpm exec ${rest}` });
  }
  return claims;
}

/**
 * Package names that provide a differently-named binary. Kept explicit and
 * tiny: resolving real bin fields would mean reading every installed package,
 * and the point of the check is that a MISSING tool is not installed to read.
 */
const BIN_PROVIDERS: Record<string, readonly string[]> = {
  playwright: ["playwright", "@playwright/test"],
  vitest: ["vitest"],
  tsc: ["typescript"],
};

/** True when some declared dependency provides `bin`. */
export function isBinDeclared(bin: string, declared: DeclaredDependencies): boolean {
  const providers = BIN_PROVIDERS[bin] ?? [bin];
  return providers.some((pkg) => declared.has(pkg));
}

/** Claims whose binary no declared dependency provides. */
export function unresolvedToolingClaims(
  claims: readonly ToolingClaim[],
  declared: DeclaredDependencies,
): ToolingClaim[] {
  return claims.filter((claim) => !isBinDeclared(claim.bin, declared));
}
