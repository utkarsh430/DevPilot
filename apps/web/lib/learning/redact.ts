// Secret / PII redaction for mistake evidence. PURE — no IO.
//
// Why this exists
// ───────────────
// A `verification_fail` mistake stores the failing check's `output_tail`, and a
// gate/human mistake stores a reason/comment body. That text is UNTRUSTED
// command output and human prose (AGENTS.md principle 6), and it lands durably in
// `agent_mistakes.evidence` — which the later lesson extractor feeds to an LLM and
// which an operator reads in the review UI. So credentials, tokens and absolute
// home paths must be scrubbed BEFORE the row is written, never after.
//
// Discipline vs the PDF export
// ────────────────────────────
// The export (lib/export/markdown.ts) uses an ALLOWLIST: it renders only the node
// types it knows are safe and drops the rest. That works when the output has
// structure to allowlist. Raw command output has none — it is an unstructured
// blob — so here we necessarily use the other tool: a BLOCKLIST scrubber over a
// LENGTH-BOUNDED string. It is defence-in-depth, not a proof: the real guarantees
// are (a) this evidence never becomes trusted instructions, (b) it is bounded, and
// (c) the patterns below cover the credential shapes this stack actually emits.
// When a pattern matches we replace the whole secret, so a near-miss leaks a
// prefix at worst, never the secret.

/** Hard cap on any stored evidence string. Keeps a runaway log out of the row. */
export const EVIDENCE_MAX_CHARS = 4000;

// Each entry replaces a matched secret with a stable placeholder. Ordering
// matters only in that more specific patterns run first (e.g. a credentialed URL
// before a bare token), so a secret is never partly caught by a broader rule.
const RULES: ReadonlyArray<{ re: RegExp; replace: string }> = [
  // Credentials embedded in a URL: https://user:pass@host → https://user:***@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, replace: "$1***@" },

  // Bearer / Basic scheme: consume the token AFTER the scheme word.
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, replace: "$1 ***" },

  // Authorization / api-key header values.
  {
    re: /\b(Authorization|X-Api-Key|api[_-]?key|apikey)\b(\s*[:=]\s*|\s+)[^\s"'`]+/gi,
    replace: "$1$2***",
  },

  // Provider-specific key shapes (Anthropic, OpenAI, GitHub, Slack, Google, AWS).
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: "sk-ant-***" },
  { re: /\bsk-[A-Za-z0-9]{16,}/g, replace: "sk-***" },
  { re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replace: "$1_***" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "github_pat_***" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: "xox***" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "AKIA***" },
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: "AIza***" },

  // JWT-shaped tokens (three base64url segments).
  { re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, replace: "eyJ***" },

  // Generic `NAME=value` / `NAME: value` where NAME looks secret-ish. The value
  // is anything up to whitespace/quote, so a real key never survives.
  {
    re: /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|ENCRYPTION_KEY)[A-Za-z0-9_]*)(\s*[:=]\s*)(?!\s)[^\s"'`]+/gi,
    replace: "$1$2***",
  },

  // Absolute home paths — leak both PII (the OS username) and host layout.
  // /Users/alice/x → /Users/<redacted>/x ; /home/bob/y → /home/<redacted>/y
  { re: /(\/Users\/)[^/\s"'`:]+/g, replace: "$1<redacted>" },
  { re: /(\/home\/)[^/\s"'`:]+/g, replace: "$1<redacted>" },
  // Windows user profile paths.
  { re: /([A-Za-z]:\\Users\\)[^\\\s"'`:]+/g, replace: "$1<redacted>" },
];

/**
 * Redact secrets/credentials/home paths from an untrusted string and bound its
 * length. Returns "" for null/undefined. Never throws.
 */
export function redactEvidence(input: string | null | undefined): string {
  if (input == null) return "";
  let out = String(input);
  for (const { re, replace } of RULES) {
    out = out.replace(re, replace);
  }
  if (out.length > EVIDENCE_MAX_CHARS) {
    out = out.slice(0, EVIDENCE_MAX_CHARS) + "…[truncated]";
  }
  return out;
}
