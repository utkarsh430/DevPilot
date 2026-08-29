// DevPilot brand palette for the PDF export — PURE.
//
// The app's colors live in `app/globals.css` as HSL *triples* inside CSS custom
// properties (`--primary: 21 90% 40%`), consumed as `hsl(var(--primary))` and
// composited with Tailwind's alpha modifiers. react-pdf has neither: no CSS
// variables, no `hsl(var(…))`, and — the one that actually bites — no alpha
// compositing against a parent background. An `rgba()` fill in react-pdf blends
// against the PAGE, not against the card it sits on, so a tint that looks right
// in the browser reads muddy in the PDF.
//
// So this module does two things:
//   1. Freezes the light-mode ("day shift") token set as flat hex. The export is
//      a printed artifact — it is always the light palette, never theme-aware.
//   2. PRECOMPUTES every tint by mixing the source color toward its intended
//      backdrop at author time (`mix()`), so the renderer only ever draws fully
//      opaque fills and what you see is what prints.
//
// Drift guard: `__tests__/theme.test.ts` parses `app/globals.css` and asserts the
// five role colors + `--primary` still match the values frozen here. Restyling
// the app is supposed to restyle the export; the test makes the export's silence
// impossible rather than merely unlikely.

/** HSL triple exactly as written in `globals.css` (`H S% L%`). */
type Hsl = readonly [h: number, s: number, l: number];

/**
 * The `:root` (DevPilot Light) tokens this document renders with. Keep the
 * values byte-identical to `app/globals.css`'s `:root` block — the drift test
 * compares against that file, so an app restyle fails here until it is carried
 * across deliberately.
 */
export const TOKENS_HSL = {
  background: [40, 20, 97],
  foreground: [230, 20, 11],
  card: [0, 0, 100],
  primary: [21, 90, 40],
  primaryForeground: [0, 0, 100],
  muted: [40, 14, 92],
  mutedForeground: [230, 8, 40],
  accent: [40, 16, 89],
  destructive: [0, 74, 46],
  success: [152, 64, 29],
  warning: [38, 92, 30],
  border: [40, 12, 86],
  // Chart accents double as the ROLE SPECTRUM (see `roleColor`).
  chart1: [217, 85, 49], // blue   — PM / product
  chart2: [152, 60, 30], // green  — QA / verification
  chart3: [38, 92, 30], // amber  — DevOps / infra
  chart4: [262, 70, 56], // violet — Engineering
  chart5: [4, 74, 46], // red    — Security
} as const satisfies Record<string, Hsl>;

export type TokenName = keyof typeof TOKENS_HSL;

/** HSL (h 0-360, s/l 0-100) → `#rrggbb`. The standard CSS Color 4 conversion. */
export function hslToHex([h, s, l]: Hsl): string {
  const sat = s / 100;
  const lum = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lum, 1 - lum);
  const f = (n: number) => lum - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Parse `#rrggbb` → `[r, g, b]` (0-255). */
function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/**
 * Composite `fg` over `bg` at `alpha` and return the flat, opaque result.
 *
 * This is the whole reason tints are precomputed: `mix(roleColor, WHITE, 0.12)`
 * at author time gives the renderer a solid hex that already looks like a 12%
 * wash on a white card. Handing react-pdf `rgba(…, 0.12)` instead would blend
 * against the page and print differently depending on what is behind the card.
 */
export function mix(fg: string, bg: string, alpha: number): string {
  const [fr, fg_, fb] = hexToRgb(fg);
  const [br, bg_, bb] = hexToRgb(bg);
  const a = Math.max(0, Math.min(1, alpha));
  const ch = (f: number, b: number) =>
    Math.round(f * a + b * (1 - a))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(fr, br)}${ch(fg_, bg_)}${ch(fb, bb)}`;
}

/** Every token as flat hex — what the stylesheets actually reference. */
export const COLORS: Record<TokenName, string> = Object.fromEntries(
  Object.entries(TOKENS_HSL).map(([k, v]) => [k, hslToHex(v)]),
) as Record<TokenName, string>;

/** The surface every tint composites against (the card, not the page). */
export const SURFACE = COLORS.card;

/**
 * The role spectrum, exactly as AGENTS.md declares it:
 *   chart-1 blue PM · chart-2 green QA · chart-3 amber DevOps ·
 *   chart-4 violet Engineer · chart-5 red Security.
 *
 * DevPilot ships ~60 role slugs against 5 colors, so this maps by FAMILY rather
 * than enumerating every slug: a role is placed by what it does, and an
 * unrecognised slug (a JD-synthesized custom role — those have arbitrary slugs)
 * falls back to `muted` rather than borrowing a family's color and implying a
 * membership it does not have.
 */
export type RoleFamily = "product" | "qa" | "devops" | "engineering" | "security" | "other";

const ROLE_FAMILY: Record<string, RoleFamily> = {
  // Product / planning — blue.
  pm: "product",
  product_manager: "product",
  technical_product_manager: "product",
  product_owner: "product",
  business_analyst: "product",
  project_program_manager: "product",
  scrum_master: "product",
  triage: "product",
  designer: "product",
  product_designer: "product",
  ui_designer: "product",
  ux_designer: "product",
  ux_researcher: "product",
  techwriter: "product",
  marketing_manager: "product",
  sales_account_executive: "product",
  customer_success_manager: "product",
  // Verification — green.
  qa: "qa",
  qa_automation_engineer: "qa",
  sdet: "qa",
  verifier: "qa",
  // Infra / operations — amber.
  devops: "devops",
  sre: "devops",
  platform_engineer: "devops",
  cloud_engineer: "devops",
  it_admin: "devops",
  dba: "devops",
  release_engineer: "devops",
  // Engineering — violet.
  engineer: "engineering",
  backend_engineer: "engineering",
  frontend_engineer: "engineering",
  fullstack_engineer: "engineering",
  mobile_engineer: "engineering",
  staff_engineer: "engineering",
  tech_lead: "engineering",
  software_architect: "engineering",
  engineering_manager: "engineering",
  implementation_specialist: "engineering",
  solutions_engineer: "engineering",
  technical_support_engineer: "engineering",
  data_analyst: "engineering",
  data_scientist: "engineering",
  dataeng: "engineering",
  analytics_engineer: "engineering",
  ml_engineer: "engineering",
  cto: "engineering",
  vp_engineering: "engineering",
  supervisor: "engineering",
  project_scaffolder: "engineering",
  // Security — red.
  security: "security",
  security_engineer: "security",
  appsec_engineer: "security",
  compliance_grc: "security",
};

const FAMILY_COLOR: Record<RoleFamily, string> = {
  product: COLORS.chart1,
  qa: COLORS.chart2,
  devops: COLORS.chart3,
  engineering: COLORS.chart4,
  security: COLORS.chart5,
  other: COLORS.mutedForeground,
};

export function roleFamily(slug: string | null | undefined): RoleFamily {
  if (!slug) return "other";
  return ROLE_FAMILY[slug] ?? "other";
}

/** The spectrum color for a role slug. Unknown slug → muted (never borrowed). */
export function roleColor(slug: string | null | undefined): string {
  return FAMILY_COLOR[roleFamily(slug)];
}

/** A precomputed, opaque wash of the role color on the card surface. */
export function roleTint(slug: string | null | undefined): string {
  return mix(roleColor(slug), SURFACE, 0.1);
}

/**
 * Trust attribution colors. Human content reads as ordinary body text; agent and
 * system content get a visible, non-alarming accent so a reader can see at a
 * glance which parts of the record the machine wrote.
 */
export const TRUST_COLOR = {
  human: COLORS.foreground,
  agent: COLORS.chart4,
  system: COLORS.mutedForeground,
} as const;

export const TRUST_LABEL = {
  human: "Human",
  agent: "Agent",
  system: "System",
} as const;

/** Status pill colors, keyed on `TicketStatus`. */
export const STATUS_COLOR: Record<string, string> = {
  backlog: COLORS.mutedForeground,
  ready: COLORS.chart1,
  assigned: COLORS.chart1,
  in_progress: COLORS.primary,
  in_review: COLORS.chart4,
  input_required: COLORS.warning,
  blocked: COLORS.warning,
  paused: COLORS.mutedForeground,
  done: COLORS.chart2,
  failed: COLORS.destructive,
};

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? COLORS.mutedForeground;
}

/** Run-status colors (`runs.status`), distinct vocabulary from tickets. */
export function runStatusColor(status: string): string {
  switch (status) {
    case "done":
      return COLORS.chart2;
    case "failed":
      return COLORS.destructive;
    case "running":
      return COLORS.primary;
    case "awaiting_human":
      return COLORS.warning;
    case "cancelled":
      return COLORS.mutedForeground;
    default:
      return COLORS.mutedForeground;
  }
}

/** Page geometry (pt). A4 with a footer band the running chrome lives in. */
export const PAGE = {
  paddingTop: 54,
  paddingBottom: 48,
  paddingHorizontal: 48,
} as const;
