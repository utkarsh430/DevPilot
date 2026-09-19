// The guide manifest — the single source of truth every guide surface derives
// from. Modelled on `components/shell/nav-config.ts`, which documents itself the
// same way and for the same reason.
//
// ── Array order IS document order ───────────────────────────────────────────
//
// Nav order, index order, in-manual TOC order, PDF bookmark order and prev/next
// order are all the order of `GUIDE`. There is deliberately no `order` field: a
// second declaration of sequence is a second thing that can disagree with the
// first, and the disagreement is invisible until a reader notices chapter 4
// arriving before chapter 3 in the PDF only.
//
// ── Subsections are DERIVED, never declared ─────────────────────────────────
//
// `guideSubsections()` reads the body's depth-2 headings. A `subsections` field
// would be a second place that can silently disagree with the prose — a sidebar
// link to `#connect-a-runner` after the heading was renamed is a dead anchor
// that nobody notices, because nothing errors and the page still loads.
//
// ── Content lives in `.ts`, not `.md` ───────────────────────────────────────
//
// See the header of `content/01-what-is-devpilot.ts`. Short version: this repo
// has a shipped-fatal-bug's worth of scar tissue about runtime file resolution,
// and a static import has no resolution step to get wrong.
//
// PURE — no `server-only`, no `next/headers`, no `"use server"` import anywhere
// in its transitive graph, because a React client component, a react-pdf
// document and a node script all have to load this.

import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  FolderGit2,
  GitMerge,
  Github,
  GraduationCap,
  LifeBuoy,
  ListChecks,
  PlugZap,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Spline,
  TicketIcon,
  Users,
} from "lucide-react";
import type { DocBlock } from "./blocks";
import { figureIdsIn, headingsIn, lowerGuideMarkdown } from "./lower";
import { WHAT_IS_DEVPILOT } from "./content/01-what-is-devpilot";
import { MEET_THE_CREW } from "./content/02-meet-the-crew";
import { BEFORE_YOU_START } from "./content/03-before-you-start";
import { CONNECT_GITHUB } from "./content/04-connect-github";
import { CREATE_YOUR_FIRST_PROJECT } from "./content/05-create-your-first-project";
import { CONNECT_A_RUNNER } from "./content/06-connect-a-runner";
import { YOUR_FIRST_TICKET } from "./content/07-your-first-ticket";
import { PLAN_MODE } from "./content/08-plan-mode";
import { REVIEWING_CHANGES } from "./content/09-reviewing-changes";
import { SKILLS_PROMPTS_LESSONS } from "./content/10-skills-prompts-lessons";
import { SAFETY_BUDGET_STOPPING } from "./content/11-safety-budget-stopping";
import { SETTINGS } from "./content/12-settings";
import { TROUBLESHOOTING } from "./content/13-troubleshooting";
import { GLOSSARY } from "./content/14-glossary";

export type GuideSection = {
  /** URL segment and PDF bookmark key. STABLE — changing one breaks shared links. */
  slug: string;
  /** Nav label, page h1, PDF heading, PDF TOC row and bookmark title. */
  title: string;
  /** Index card, PDF TOC subtitle, `<meta description>`. One sentence. */
  summary: string;
  /** Index grid only. Never reaches the PDF — react-pdf cannot draw a Lucide icon. */
  icon?: LucideIcon;
  /** Markdown body, from `content/NN-slug.ts`. */
  body: string;
  /**
   * Figure ids this section may reference.
   *
   * Declared as well as referenced so BOTH directions are testable: a `figure:`
   * reference with no declaration is a typo, and a declaration with no reference
   * is an orphan — a captured, committed, byte-carrying PNG that no reader will
   * ever see, and which nothing else would surface.
   */
  figures: readonly string[];
};

export type GuideChapter = {
  label: string;
  sections: readonly GuideSection[];
};

export const GUIDE: readonly GuideChapter[] = [
  {
    label: "Understand",
    sections: [
      {
        slug: "what-is-devpilot",
        title: "What DevPilot is",
        summary:
          "The board is an orchestration substrate, not a status display — and what has to be true before anything runs.",
        icon: BookOpen,
        body: WHAT_IS_DEVPILOT,
        figures: ["board-orchestration"],
      },
      {
        slug: "meet-the-crew",
        title: "Meet the crew",
        summary:
          "Roles are briefs, not people. How work is handed from one to the next, and what stops a reviewer and a producer disagreeing forever.",
        icon: Users,
        body: MEET_THE_CREW,
        figures: ["handoff-chain"],
      },
    ],
  },
  {
    label: "Set up",
    sections: [
      {
        slug: "before-you-start",
        title: "Before you start",
        summary:
          "What has to exist first — a GitHub account, a signed-in Claude CLI, and a runner process willing to do the work.",
        icon: ListChecks,
        body: BEFORE_YOU_START,
        figures: ["readiness-checklist"],
      },
      {
        slug: "connect-github",
        title: "Connect GitHub",
        summary:
          "The four scopes DevPilot asks for, why `workflow` is not implied by `repo`, and why adding a scope needs you to re-authorise.",
        icon: Github,
        body: CONNECT_GITHUB,
        figures: ["github-scopes"],
      },
      {
        slug: "create-your-first-project",
        title: "Create your first project",
        summary:
          "New repository or one you already have, the integration branch agents land into, and the three framing choices on the form.",
        icon: FolderGit2,
        body: CREATE_YOUR_FIRST_PROJECT,
        figures: ["integration-branch"],
      },
      {
        slug: "connect-a-runner",
        title: "Connect a runner",
        summary:
          "Nothing executes without a live runner. How to start one, how to tell it actually connected, and what each failure signal means.",
        icon: PlugZap,
        body: CONNECT_A_RUNNER,
        figures: ["runner-connected"],
      },
    ],
  },
  {
    label: "Do the work",
    sections: [
      {
        slug: "your-first-ticket",
        title: "Your first ticket",
        summary:
          "The full status lifecycle, which dependency kinds actually block, and how a reply to an Input required ticket resumes it.",
        icon: TicketIcon,
        body: YOUR_FIRST_TICKET,
        // Two, because the section walks through two genuinely different
        // screens: the relations panel, and the drawer of a ticket that is
        // waiting on a reply.
        figures: ["ticket-dependencies", "ticket-input-required"],
      },
      {
        slug: "plan-mode",
        title: "Plan mode",
        summary:
          "Describe a feature in prose, settle scope with a lead, and commit a dependency-ordered backlog — and why a new repo's scaffolder waits for it.",
        icon: Sparkles,
        body: PLAN_MODE,
        figures: ["plan-review"],
      },
      {
        slug: "reviewing-changes",
        title: "Reviewing what the crew produced",
        summary:
          "The Changes queue, why landed is not the same as Done, and the guard that refuses to restart a ticket whose branch holds unpushed commits.",
        icon: GitMerge,
        body: REVIEWING_CHANGES,
        // The review queue and the board are two surfaces telling two halves of
        // one story - what is waiting to be pushed, and what never landed.
        figures: ["changes-queue", "landing-not-landed"],
      },
    ],
  },
  {
    label: "Steer",
    sections: [
      {
        slug: "skills-prompts-lessons",
        title: "Skills, prompts and lessons",
        summary:
          "The three ways to change what an agent knows - and why every one of them adds to a role's brief rather than replacing it.",
        icon: GraduationCap,
        body: SKILLS_PROMPTS_LESSONS,
        // Three, and the title is the argument: skills, prompts and lessons are
        // three separate mechanisms with three separate screens, and this
        // section has four subsections covering them. One figure would have to
        // pick a favourite.
        figures: ["skill-review", "prompt-layers", "lesson-review"],
      },
      {
        slug: "safety-budget-stopping",
        title: "Safety, budget and stopping things",
        summary:
          "What an agent may finish on its own, what it may spend, and the two pause controls whose blast radii are nothing alike.",
        icon: ShieldAlert,
        body: SAFETY_BUDGET_STOPPING,
        figures: ["safety-critical", "run-cost-ceiling"],
      },
    ],
  },
  {
    // The glossary alone carries no figure, and that is a judgement rather than
    // an omission: it is definitions, with no screen behind them. See
    // `GUIDE_FIGURES_DECLINED` in `figures.ts`, which records it alongside every
    // other screen considered and refused.
    label: "Operate & reference",
    sections: [
      {
        slug: "settings",
        title: "Settings you'll actually touch",
        summary:
          "Auth mode, provider, API keys, billing and health — plus the one distinction worth being precise about: which of your stored credentials an agent can read.",
        icon: SlidersHorizontal,
        body: SETTINGS,
        figures: ["settings-llm-auth", "platform-secret-shared"],
      },
      {
        slug: "troubleshooting",
        title: "When something goes wrong",
        summary:
          "The failure modes people actually hit, each paired with the exact signal it produces — and the surface that is telling the truth.",
        icon: LifeBuoy,
        body: TROUBLESHOOTING,
        figures: ["run-failed"],
      },
      {
        slug: "glossary",
        title: "Glossary",
        summary:
          "The ordinary words DevPilot uses with specific meanings, defined as the product actually uses them.",
        icon: Spline,
        body: GLOSSARY,
        figures: [],
      },
    ],
  },
] as const;

// ── Derived. Never hand-maintained. ────────────────────────────────────────

/** Every section, flattened, in document order. */
export const GUIDE_SECTIONS: readonly GuideSection[] = GUIDE.flatMap((c) => c.sections);

export const GUIDE_BY_SLUG: ReadonlyMap<string, GuideSection> = new Map(
  GUIDE_SECTIONS.map((s) => [s.slug, s]),
);

/** The chapter a section belongs to — breadcrumbs render it as plain text. */
export const GUIDE_CHAPTER_BY_SLUG: ReadonlyMap<string, GuideChapter> = new Map(
  GUIDE.flatMap((c) => c.sections.map((s) => [s.slug, c] as const)),
);

export type GuidePager = {
  prev: GuideSection | null;
  next: GuideSection | null;
};

/**
 * Previous / next across the WHOLE guide, not within a chapter.
 *
 * Chapter-local paging would dead-end a reader at the last section of chapter 2
 * with no forward control, which on a linear manual reads as the guide ending.
 * A slug that is not in the manifest yields `{ prev: null, next: null }` rather
 * than throwing — a 404 page may still want to render a pager shell.
 */
export function guidePager(slug: string): GuidePager {
  const i = GUIDE_SECTIONS.findIndex((s) => s.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: GUIDE_SECTIONS[i - 1] ?? null,
    next: GUIDE_SECTIONS[i + 1] ?? null,
  };
}

export type GuideSubsection = { anchor: string; title: string };

/**
 * A section's subsections, DERIVED from the depth-2 headings its body actually
 * contains. Anchors come from the lowering, so they are the same strings the
 * rendered headings carry — one derivation, five consumers.
 */
export function guideSubsections(section: GuideSection): GuideSubsection[] {
  return headingsIn(lowerGuideSection(section), 2);
}

// Lowering is deterministic and the corpus is small and static, so results are
// memoised per section. Without this, a page render, its TOC and the sidebar
// would each re-parse the same markdown.
const lowered = new Map<string, DocBlock[]>();

/** Lower a section's body, memoised. Throws on an authoring mistake — see `lower.ts`. */
export function lowerGuideSection(section: GuideSection): DocBlock[] {
  const hit = lowered.get(section.slug);
  if (hit) return hit;
  const blocks = lowerGuideMarkdown(section.body, section.slug);
  lowered.set(section.slug, blocks);
  return blocks;
}

/** Figure ids a section's body actually references, in document order. */
export function guideSectionFigureRefs(section: GuideSection): string[] {
  return figureIdsIn(lowerGuideSection(section));
}
