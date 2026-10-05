// The figure registry - `figureId` → `GuideFigure`.
//
// ── Ownership ───────────────────────────────────────────────────────────────
//
// The WEB crew created this file so the renderer had something to resolve an id
// from; the CAPTURE crew owns the DATA in `GUIDE_FIGURES`, the PNGs under
// `public/guide/`, and `scripts/guide-capture.mjs`.
//
// `id`, `file`, `alt`, `caption`, `route`, `watch` and the capture spec are
// AUTHORED - a human decides what a figure is for and what composes it.
//
// `width`, `height`, `capturedAt`, `theme`, `build` and `fingerprint` are
// PROVENANCE, written ONLY by the capture script, atomically with the PNG it
// just produced. That single fact is what the freshness design rests on: a
// fingerprint recorded by the same run that produced the pixels is evidence the
// two agree, whereas a hand-typed one is a claim about nothing. The type system
// does not and cannot enforce it - see `GUIDE_PROVENANCE_UNPROVEN_EXAMPLE` in
// `freshness.ts`, a hand-authored entry asserted to PASS the provenance check.
// The check verifies that a claim is well-formed, never that a capture happened.
// Only review of the committed PNG can do that.
//
// ── An unresolvable id is a RENDER outcome, not a throw ────────────────────
//
// `lower.ts` already errors at module load on an image that is not a `figure:`
// reference, and `manifest.test.ts` cross-checks declared-vs-referenced ids. So
// the id in a `DocBlock` is well-formed by the time it reaches here; what this
// lookup cannot promise is that the figure has been CAPTURED yet. The renderer's
// answer is the same as its answer to a missing PNG: draw a visible placeholder.
// Throwing would take a whole page down over one absent screenshot.
//
// ── Prose-first ─────────────────────────────────────────────────────────────
//
// A figure earns its place only where the UI is genuinely hard to describe in a
// sentence. Everything a sentence can carry should be a sentence: prose is
// searchable, translatable, diffable and free, while a figure is bytes in the
// download plus a thing that rots. Prefer a CROPPED detail of one component over
// a full-page dashboard - less to change, less theme signal, smaller bytes, and
// the reader's eye lands on the thing being explained rather than on the chrome.
// `GUIDE_FIGURES_DECLINED` at the foot of this file records what was refused.
//
// PURE - no `server-only`, no node builtins. `freshness.ts` is the module that
// hashes files and it is build/test-time ONLY; a renderer reads
// `staleAcknowledged` off this static data instead, which is what lets the PDF
// (with no repo source to hash) draw the same badge.

import type { GuideFigure } from "./blocks";
import {
  GUIDE_FIXTURE_BUILDS_ON_TICKET_ID,
  GUIDE_FIXTURE_FAILED_RUN_ID,
  GUIDE_FIXTURE_INPUT_REQUIRED_TICKET_ID,
  GUIDE_FIXTURE_IN_REVIEW_TICKET_ID,
  GUIDE_FIXTURE_PROJECT_ID,
  GUIDE_FIXTURE_RUN_ID,
} from "./fixture";

/**
 * Every captured figure, in no particular order - sections reference by id.
 *
 * ONE FIGURE PER SECTION THAT TEACHES A SCREEN, two or three where a section
 * genuinely walks through that many. Thirteen of the guide's fourteen sections
 * carry at least one; the fourteenth is the glossary, which is definitions and
 * has no screen to show. `GUIDE_FIGURES_DECLINED` at the foot of this file
 * records every screen that was considered and refused, with the reason - and
 * three of those refusals are determinism findings a future author would
 * otherwise rediscover by committing a figure that diffs on every recapture.
 *
 * The budget in `freshness.ts` is a ceiling, not a target. It was raised from
 * twelve when the guide went from "a few images" to "a picture of every screen
 * it teaches"; the per-FILE ceiling was deliberately left where it was, because
 * the thing that keeps a manual downloadable is cropping tightly rather than
 * allowing fewer, larger pictures.
 */
export const GUIDE_FIGURES: readonly GuideFigure[] = [
  {
    id: "board-orchestration",
    file: "board-orchestration.png",
    alt: "Five board columns side by side - Backlog, Ready, In Progress, Input Required and In Review - each holding one ticket card with its title, its DevPilot-N key and how long ago it last moved. The Input Required card additionally shows the opening line of the agent's question and a comment count.",
    caption:
      "The column a ticket sits in is its live state, not a label someone applied afterwards. Input Required is the engine waiting on you, and the card shows what it asked.",
    width: 1668,
    height: 212,
    route: "/board",
    // The board's own client, the card in the frame, and the two pure modules
    // that decide which column a ticket lands in and in what order. Deliberately
    // NOT `components/board/**`: the dialogs, filters and drag handlers in that
    // directory are not in this frame, and a glob that swept them in would go
    // red on edits the figure cannot possibly show - which is how a freshness
    // gate becomes noise and then gets deleted.
    watch: [
      "components/board/BoardClient.tsx",
      "components/board/TicketCard.tsx",
      "lib/board/column-sort.ts",
      "lib/board/state.ts",
    ],
    fingerprint: "a230b59ba985a1f5395e1d5499761fa63e44e76b862005a58ad27d778665fdc8",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "4f5d794f9647c1e2bb1ae3a6d211815de9b18acf74334ce2be070001ae95664a",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "runner-connected",
    file: "runner-connected.png",
    alt: "A run's six steps listed in order: a think step, three tool calls reading a file, editing it and running the tests, the test result, and a closing think step handing the ticket to QA. Each row carries the elapsed time since the previous step and its cost.",
    caption:
      "Steps accumulating on the Runs page is how you confirm a runner actually connected. A runner that started but never claimed work leaves this empty.",
    width: 800,
    height: 508,
    route: "/runs/:id",
    watch: [
      "components/runs/StepTree.tsx",
      "components/runs/RunInspector.tsx",
      "lib/runs/queries.ts",
    ],
    fingerprint: "09aee8d1133efb6293abce47ba7a7c700c5aa4886926c4dc06800b9e987149a8",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "5ea1917cd86a57d54345d2f9e022a164ec7c73a7e4d3ec22fb6bf9dffdedd779",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },

  // ── Chapter 1 · Understand ────────────────────────────────────────────────
  {
    id: "handoff-chain",
    file: "handoff-chain.png",
    alt: "Four role cards in a row joined by arrows - PM (refines the ticket), Engineer (implements the change), QA (reviews and tests), Security (audits the diff) - under the heading 'How the team works'.",
    caption:
      "The canonical loop, drawn on the Agents page. Specialist roles slot into the same chain rather than replacing it.",
    width: 1104,
    height: 156,
    route: "/agents",
    watch: [
      "app/(app)/agents/page.tsx",
      "components/roles/handoff-diagram.tsx",
      "lib/roles/index.ts",
    ],
    fingerprint: "ef10e8fb44614c0cef0a117673a26d603444483eaffce4d389e9fe1371f2b155",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "4a4601d03e003571659b6cb82261681666e8ddf49314ee9e7faa16869d909752",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },

  // ── Chapter 2 · Set up ────────────────────────────────────────────────────
  {
    id: "readiness-checklist",
    file: "readiness-checklist.png",
    alt: "A popover headed 'Get started with DevPilot - 2 steps left before your crew runs end to end', listing four steps: Connect GitHub with a Connect link, a ticked Create your first project, Connect your runner with a Set up link, and a ticked Finish your first run.",
    caption:
      "The topbar checklist is the shortest answer to 'what still has to be true'. It counts down as each prerequisite lands.",
    width: 320,
    height: 264,
    route: "/board",
    watch: [
      "components/shell/readiness-checklist.tsx",
      "components/shell/topbar.tsx",
      "lib/onboarding/readiness.ts",
    ],
    fingerprint: "8f0838072663a75c3f7150e8bc71e83f5551a03f9c0c3b628c1b5b9b4d1490f6",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "038f6893c8fa3d100dd69dbe892c142f3c7804ff254802ad3d6c9306016c010c",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "github-scopes",
    file: "github-scopes.png",
    alt: "The GitHub integration card in the Not connected state, listing four requested OAuth scopes - repo, workflow, read:user and user:email - each with a sentence on what it buys, plus a paragraph singling out workflow as the widest, and a Continue with GitHub button.",
    caption:
      "Every scope DevPilot asks for, with what it buys. The page says out loud that `workflow` is the widest of the four rather than burying it.",
    width: 724,
    height: 374,
    route: "/settings/github-integration",
    watch: [
      "app/(app)/settings/github-integration/github-integration-client.tsx",
      "app/(app)/settings/github-integration/page.tsx",
      "lib/github/scopes.ts",
    ],
    fingerprint: "e9ad72b402474cf133716ab2b3927cc9f6062fef29cafdfd7c6c6ee526bed419",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "f2cba63096fa4dabee5e54579bf55316a1049d9125f54101ce61d51269c6b080",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "integration-branch",
    file: "integration-branch.png",
    alt: "The Branch routing card showing two branches side by side - PRODUCTION main, 'the default branch, promotions land here', and INTEGRATION dev, 'agent ticket branches cut from and PR into this' - with auto-land ticked Enabled and a Promote button.",
    caption:
      "Two branches with different jobs. Agents work against the integration branch; promotion to production stays a separate, human step.",
    width: 1000,
    height: 332,
    route: "/projects/:id",
    watch: [
      "app/(app)/projects/[projectId]/branch-routing-card.tsx",
      "lib/integration/connect-integration-branch.ts",
      "lib/projects/load.ts",
    ],
    fingerprint: "2f5c8dc5ffd5b7345d2faa3762f26be8f1700dd69eb9efca62c6333225b05785",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "895c0d21743989c1dc547d28834ddc1520fc92885ecb9777fc801b20ccd9bce1",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },

  // ── Chapter 3 · Do the work ───────────────────────────────────────────────
  {
    id: "ticket-input-required",
    file: "ticket-input-required.png",
    alt: "A ticket drawer headed 'Which chart datum are the heights measured from?' carrying an Input required chip and an 'Awaiting your reply' chip, with the agent's question in the thread below and a reply box placeheld 'The agent is waiting on you. Reply to resume the run.'",
    caption:
      "An agent that hits a decision it cannot make asks and parks. Nothing is spinning while it waits, and your reply is what restarts it.",
    width: 576,
    height: 608,
    route: "/board?ticket=:id",
    watch: [
      "components/board/TicketDrawer.tsx",
      "lib/board/state.ts",
      "app/(app)/board/actions.ts",
    ],
    fingerprint: "82383c0323c67b622ae38bf1a6b572f4983b6ee7446fcab131fc18668fac8c34",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "df10a99447871575b27711c2c479d4de6a161e3d3b9357db88ed175b5d4f1f18",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "ticket-dependencies",
    file: "ticket-dependencies.png",
    alt: "The dependencies section of a ticket drawer: 'DEPENDENCIES (1)' listing a ticket in the ready state that must finish first, and below it 'RELATIONS' with a 'Builds on' chip counting one, naming the same ticket.",
    caption:
      "The same row appears twice on purpose: `builds_on` is a relation you record, and it is also what holds this ticket out of Ready until the other one is finished.",
    width: 556,
    height: 196,
    route: "/board?ticket=:id",
    watch: ["components/board/TicketDrawer.tsx", "lib/board/dependencies.ts", "lib/board/topo.ts"],
    fingerprint: "79d4df8b62aba87b8e2d2dc413fccea7b2f9b043b49ee929c486eb8abae3ed5a",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "a160311ab9c0fe72df80a67a8ac248f1c2758c2fa0781bcf492c7e420376c437",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "plan-review",
    file: "plan-review.png",
    alt: "The plan panel at its Review stage, with Describe, Refine and Build already ticked and four proposed tickets listed beneath. Each is ticked, editable in place, and carries a role chip and its dependency edges - 'blocks #2', 'depends on #1 blocks #4', 'depends on #2, #3'.",
    caption:
      "Review is the phase worth reading. Nothing exists on the board yet - the dependency edges shown here are what the committed backlog is ordered by.",
    width: 768,
    height: 600,
    route: "/plan",
    watch: [
      "components/plan/ProposedTicketsReview.tsx",
      "components/plan/PlanSheet.tsx",
      "components/plan/PlanStageRail.tsx",
      "lib/plan/stage-rail.ts",
    ],
    fingerprint: "5337b5b3d6de24fb35f9681286241fec1d6496541fce5419ec286db26454f7c8",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "36cfb28f16f3f0652b038f42413e9cdf2ea5d3bf0a62c01e534d3806259d8acb",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "changes-queue",
    file: "changes-queue.png",
    alt: "One row in the Changes review queue: the project name, the branch devpilot/retry-the-station-feed-on-a-502, the ticket title, and a summary reading two files, 92 additions, 6 deletions, 2 commits.",
    caption:
      "A row exists only because the workspace holds commits the remote does not. A ticket that changed nothing never appears here at all.",
    width: 980,
    height: 140,
    route: "/changes",
    watch: [
      "app/(app)/changes/changes-list-client.tsx",
      "app/(app)/changes/page.tsx",
      "lib/engine/pending-push-tracker.ts",
    ],
    fingerprint: "4671a011601172ba980aaf0b08b6838e2e8dc4f27f1670a86f9b0f557e12542b",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "82614769894255bee0c0764fef71cf74901a26f5d9c77c776a67d0ff1b6edf34",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "landing-not-landed",
    file: "landing-not-landed.png",
    alt: "The Done column holding three cards. The top one carries an amber chip reading 'Not landed - land failed' followed by the push rejection GitHub returned, and a second chip offering to review the two changes on its branch. The two cards below it carry no chip at all.",
    caption:
      "Done is a verdict about the work; landed is a fact about the code. A chip appears only when they disagree - the quiet cards below it are the boring majority.",
    width: 340,
    height: 490,
    route: "/board",
    watch: [
      "components/board/TicketCard.tsx",
      "lib/integration/landing-state.ts",
      "lib/integration/landing-records.ts",
    ],
    fingerprint: "a5320063366029ccbb0e40d2e0b34a7211af39a99223c0842b3af196061389f6",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "f3dca1f21894088d71ea27945d90a40aeb3a7acde83fc6b8cdfe1733907fb07d",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },

  // ── Chapter 4 · Steer ─────────────────────────────────────────────────────
  {
    id: "skill-review",
    file: "skill-review.png",
    alt: "The review panel for a marketplace skill, showing the roles it attaches to and the trigger words that make it fire, a list of exactly what installing changes, and the beginning of the skill's body under a heading reading 'Body - this text is merged into a system prompt'.",
    caption:
      "Review before you install. The body is prompt text that will be merged into a role's standing brief, so the panel shows it rather than summarising it.",
    width: 768,
    height: 694,
    route: "/marketplace",
    watch: [
      "components/marketplace/skill-preview.tsx",
      "lib/marketplace/skill-view.ts",
      "lib/skills/merge.ts",
    ],
    fingerprint: "98bfb192fe64635f7bdc808ed41a860d2eade988bea4c8502eef301168677b69",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
  },
  {
    id: "prompt-layers",
    file: "prompt-layers.png",
    alt: "A card headed 'How this agent's instructions are put together', listing three numbered layers with their character counts - the role prompt, the safety contract, and a reviewer-awareness note - each with a line saying where it comes from and whether your own instructions can overrule it.",
    caption:
      "The brief is assembled fresh on every dispatch. An overlay you write is appended to this stack; it never edits the shipped prompt, and it never outranks the safety contract.",
    width: 848,
    height: 372,
    route: "/agents/:slug",
    watch: [
      "app/(app)/agents/[slug]/prompt-view.tsx",
      "lib/roles/prompt-inspection.ts",
      "lib/roles/compose-prompt.ts",
    ],
    fingerprint: "7311333321612e17a12daeba7cf6d782be118afd55d6ebaac0dd3fc1ba06bf9c",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "b961a520678ebf56e3da30a72ecfd6212d3cd1a9d6528e13e22f19a3dd04f1e7",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "lesson-review",
    file: "lesson-review.png",
    alt: "A lesson awaiting review, tagged High confidence, scoped to the engineer role and categorised as verification. It carries the lesson text, the extractor's reason for its confidence, the mistake it was drawn from with the failing command and output, and Accept, Reject, Skip and Edit buttons.",
    caption:
      "An approved lesson becomes standing guidance on every future run, so nothing reaches that state without a human. The confidence grade is what makes a long queue triageable.",
    width: 772,
    height: 490,
    route: "/learnings",
    watch: [
      "app/(app)/learnings/queue-client.tsx",
      "app/(app)/learnings/confidence-badge.tsx",
      "lib/learning/select.ts",
    ],
    fingerprint: "9b4c8eda7de5b980f6a215320be3e198c4ae67bc3a0c917d81721ce6e98645c7",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
  },

  // ── Chapter 4 · Safety and spend ──────────────────────────────────────────
  {
    id: "safety-critical",
    file: "safety-critical.png",
    alt: "The Safety section of a ticket drawer: a card reading 'Safety-critical - flag this when the work needs a qualified human to sign off before it can reach Done', with a Mark safety-critical button.",
    caption:
      "Flagging a ticket safety-critical means no agent can move it to Done, whatever it concludes. Only a human can, and only from this drawer.",
    width: 556,
    height: 124,
    route: "/board?ticket=:id",
    watch: [
      "components/board/TicketDrawer.tsx",
      "lib/board/safety-gate.ts",
      "lib/board/transitions.ts",
    ],
    fingerprint: "2cf0cdab86421656055e852de0318b6104c5448271df6a70b770f54b6a5e2409",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "2bdd3d4c5c6a87b1fe586a727a0164fe7d0dfbb8b3a0a786b8e88772db4df4e2",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "run-cost-ceiling",
    file: "run-cost-ceiling.png",
    alt: "The cost card from a run inspector: 34 cents spent of a five dollar budget, a progress bar, and a note reading '7% of the per-run cap. The engine only refuses new tool/think steps once the cap is hit; this run is under it.'",
    caption:
      "Every run carries its own ceiling and the inspector shows the distance to it. The cap is checked before a step is allowed, not reconciled afterwards.",
    width: 280,
    height: 186,
    route: "/runs/:id",
    watch: ["components/runs/RunInspector.tsx", "lib/billing/gate.ts", "lib/llm/cost.ts"],
    fingerprint: "eca896f158d81e557db2aa0ddcd9c1733a5c2b7c259899df98c1c455dce0c926",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "4438c37f88c5e5a91ec92c8f69613a1174987e7c1ca48d8afb0367ff356d42a7",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },

  // ── Chapter 5 · Operate & reference ───────────────────────────────────────
  {
    id: "settings-llm-auth",
    file: "settings-llm-auth.png",
    alt: "The settings tab strip - Setup, Appearance, Notifications, Agent preferences, LLM auth, API keys, Platform secrets, Billing, GitHub, System health - above two cards offering Claude Code subscription, ticked and badged Recommended, and Anthropic API key.",
    caption:
      "Settings is one flat strip of tabs. LLM auth is the choice that decides whether your agents bill a subscription through the local runner or an API key per token.",
    width: 1248,
    height: 332,
    route: "/settings/llm-auth",
    watch: [
      "app/(app)/settings/tabs.tsx",
      "app/(app)/settings/llm-auth/llm-auth-form.tsx",
      "lib/llm/auth-mode.ts",
    ],
    fingerprint: "b50886afd7fac901bb1792372e0f29a8a8e4833d65f460d6015ff90f55c18618",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
  },
  {
    id: "platform-secret-shared",
    file: "platform-secret-shared.png",
    alt: "A platform secret row for the Vercel API token, carrying an 'Agents can read' badge beside its Optional and Env default badges, and a highlighted paragraph explaining that the value is placed in every project's agent environment unless that project defines the key itself.",
    caption:
      "The one distinction worth being precise about. Most platform secrets never reach an agent; the few that do say so on their own row.",
    width: 858,
    height: 220,
    route: "/settings/platform-secrets",
    watch: [
      "app/(app)/settings/platform-secrets/platform-secrets-client.tsx",
      "lib/platform-secrets/catalog.ts",
      "lib/platform-secrets/agent-shared.ts",
    ],
    fingerprint: "c6f604a2601ce799edb6c9d11af078a327755d47a08edf5add7fa2fb8abb01e4",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "382df23f28745c5867b4e24ec1393aa059b56d1b7b3fbdadb0e21c8029c7f068",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
  {
    id: "run-failed",
    file: "run-failed.png",
    alt: "The header of a failed run: the run id with failed and local-cc chips, a line reading 'Started 6d ago, 69m00s elapsed, 4 steps', and a red banner headed 'Run failed' carrying the reason - local-cc step 1 timed out after 1h.",
    caption:
      "When something has gone wrong, the run inspector is the surface that says what. The banner carries the engine's own reason rather than a generic failure.",
    width: 1104,
    height: 157,
    route: "/runs/:id",
    watch: ["components/runs/RunInspector.tsx", "lib/runs/queries.ts", "lib/engine/run-agent.ts"],
    fingerprint: "4da0998c6658ae7e42608256fee64e3ef1c730931fb8e8b65642664c86e9ee14",
    capturedAt: "2026-07-22T03:20:24.125Z",
    theme: "light",
    build: "03f50a8",
    staleAcknowledged: {
      fingerprint: "4089ae3a99ddee3be868d7f3a30fbd5fe593c690481e9aaacd307c27d27a5b95",
      note: "Watched files changed in the DevPilot product rename (brand strings, identifiers and the renamed logo module), on top of any earlier drift. The captured pixels still show the previous wordmark and will be recaptured; the layout and the data in frame are unchanged.",
      since: "2026-10-04",
    },
  },
];

const BY_ID: ReadonlyMap<string, GuideFigure> = new Map(GUIDE_FIGURES.map((f) => [f.id, f]));

/** Resolve a figure id. `undefined` means "not captured yet", never an error. */
export function figureById(id: string): GuideFigure | undefined {
  return BY_ID.get(id);
}

/**
 * How many figures carry a stale acknowledgement, and how many there are.
 *
 * Read off the static manifest - never hashed at render time. `freshness.ts`
 * uses `node:crypto` and is unavailable to a client component and to the PDF
 * lambda alike; the acknowledgement is a durable typed constant precisely so
 * both surfaces can report it without recomputing anything.
 */
export function guideStaleFigureCount(figures: readonly GuideFigure[] = GUIDE_FIGURES): {
  stale: number;
  total: number;
} {
  return {
    stale: figures.filter((f) => f.staleAcknowledged).length,
    total: figures.length,
  };
}

// ── The capture side ────────────────────────────────────────────────────────
//
// Kept separate from `GUIDE_FIGURES` because a renderer has no business knowing
// a selector or a crop rectangle, and because everything here is AUTHORED while
// half of `GuideFigure` is machine-written - mixing them would invite a capture
// run to rewrite a human's wait selector.

/**
 * A capture region, in CSS pixels of the pinned 1280×800 viewport.
 *
 * A literal rectangle rather than a selector's bounding box, on purpose: a
 * bounding box moves whenever an unrelated sibling reflows, so the "same" figure
 * silently reframes between captures and every recapture is an unreviewable
 * binary diff. A literal changes only when a human changes it.
 */
export type FigureCrop = { x: number; y: number; width: number; height: number };

/**
 * One deterministic interaction to perform before the shutter.
 *
 * A closed union rather than a callback: these run inside a script that is the
 * sole writer of committed provenance, and "arbitrary code from the registry"
 * is a much larger surface than the three things any figure has needed.
 */
export type FigurePrepareStep =
  | { kind: "click"; selector: string }
  /** Scroll every scrollable container back to the top. */
  | { kind: "scrollTop" };

export type FigureCaptureSpec = {
  id: string;
  /** Path to visit, relative to the app origin. */
  path: string;
  /**
   * A selector that must be attached before anything else happens.
   *
   * Declared per figure and never a bare timeout: a timeout is a guess that is
   * simultaneously too long on a warm run and too short on a cold one, and when
   * it is too short the result is a screenshot of a spinner that looks exactly
   * like a real screenshot.
   */
  waitFor: string;
  prepare?: readonly FigurePrepareStep[];
  /**
   * Viewport for this figure, defaulting to `GUIDE_DEFAULT_VIEWPORT`.
   *
   * Per figure because a crop cannot rescue a layout the viewport truncated: at
   * 1280 the board fits four columns and cuts the fifth in half, which reads to a
   * reader as a rendering bug rather than as a deliberate frame. Still pinned -
   * the point is determinism, not one particular number.
   */
  viewport?: { width: number; height: number };
  crop: FigureCrop;
};

/** Pinned so a different laptop produces the same pixels. */
export const GUIDE_DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

export const GUIDE_FIGURE_CAPTURE: readonly FigureCaptureSpec[] = [
  {
    id: "board-orchestration",
    path: "/board",
    // The first column header. Present only once the board has resolved a
    // project and rendered its columns, which is the state being photographed.
    waitFor: "text=BACKLOG",
    // Wide enough for five whole columns - Backlog through In Review. Done sits
    // just past the right edge, and the crop stops short of it rather than
    // including a sliver.
    viewport: { width: 1760, height: 900 },
    crop: { x: 22, y: 156, width: 1668, height: 212 },
  },
  {
    id: "runner-connected",
    // The fixture id is interpolated from its ONE home rather than written out
    // again here; a second copy is a second thing that can drift from the seed,
    // and its failure mode is a 404 in the middle of a capture run.
    path: `/runs/${GUIDE_FIXTURE_RUN_ID}`,
    waitFor: '[role="tab"]:has-text("List")',
    // Taller than the default so all six step rows fit without scrolling; the
    // crop is what bounds the figure, the viewport only has to contain it.
    viewport: { width: 1280, height: 1000 },
    prepare: [
      // The Trace card opens on the Waterfall, which is a timing view; the guide
      // is talking about steps arriving, so switch to the list.
      { kind: "click", selector: '[role="tab"]:has-text("List")' },
      // The inspector auto-selects the FIRST step, which expands it to full
      // output and raw payload and pushes every other step below the fold -
      // a figure of one step, captioned as if it showed six. Selecting the LAST
      // step instead leaves all six rows visible in order, which is the point.
      { kind: "click", selector: 'li:has-text("#5")' },
      // Playwright scrolls an element into view to click it, so the list is left
      // scrolled down. Returning it to the top is what makes the framing
      // identical on every run rather than dependent on row heights.
      { kind: "scrollTop" },
    ],
    crop: { x: 392, y: 234, width: 800, height: 508 },
  },

  // ── Chapter 1 ─────────────────────────────────────────────────────────────
  {
    id: "handoff-chain",
    path: "/agents",
    waitFor: 'text="How the team works"',
    crop: { x: 88, y: 188, width: 1104, height: 156 },
  },

  // ── Chapter 2 ─────────────────────────────────────────────────────────────
  {
    id: "readiness-checklist",
    // Lives in the topbar, so any signed-in page would do. The board is the page
    // a reader at this point in the guide is most likely to be standing on.
    path: "/board",
    waitFor: 'button:has-text("Get started")',
    prepare: [{ kind: "click", selector: 'button:has-text("Get started")' }],
    crop: { x: 626, y: 50, width: 320, height: 264 },
  },
  {
    id: "github-scopes",
    path: "/settings/github-integration",
    // The NOT-connected state is the one worth photographing: it is what a
    // reader on this page is looking at, and it is the only state that lists
    // every scope with what it buys. The fixture deliberately has no GitHub
    // connection - see the DECLINED note about seeding one.
    waitFor: 'text="Not connected"',
    crop: { x: 278, y: 274, width: 724, height: 374 },
  },
  {
    id: "integration-branch",
    path: `/projects/${GUIDE_FIXTURE_PROJECT_ID}`,
    waitFor: 'text="Branch routing"',
    // The card sits a long way down a single-column page, and a `clip` is
    // measured against the VIEWPORT rather than the document - so the viewport
    // has to be tall enough to contain it. Scrolling instead would put the crop
    // at the mercy of scroll position, which is exactly the class of
    // non-determinism the literal rectangle exists to remove.
    viewport: { width: 1280, height: 2800 },
    crop: { x: 150, y: 2280, width: 1000, height: 332 },
  },

  // ── Chapter 3 ─────────────────────────────────────────────────────────────
  {
    id: "ticket-input-required",
    path: `/board?ticket=${GUIDE_FIXTURE_INPUT_REQUIRED_TICKET_ID}`,
    waitFor: 'button:has-text("Thread")',
    prepare: [{ kind: "click", selector: 'button:has-text("Thread")' }],
    // Deliberately SHORT. The drawer is viewport-height with the composer pinned
    // to its foot, so a taller viewport pushes a growing band of empty thread
    // between the question and the reply box - and the whole point of the figure
    // is that those two are one screen.
    viewport: { width: 1280, height: 620 },
    crop: { x: 704, y: 6, width: 576, height: 608 },
  },
  {
    id: "ticket-dependencies",
    path: `/board?ticket=${GUIDE_FIXTURE_BUILDS_ON_TICKET_ID}`,
    // Waits on the relation CHIP rather than the section label: the label is
    // upper-cased by CSS, so its DOM text is "Relations" and an exact-match
    // selector on the rendered casing never resolves.
    waitFor: 'text="Builds on"',
    viewport: { width: 1280, height: 1000 },
    crop: { x: 716, y: 648, width: 556, height: 196 },
  },
  {
    id: "plan-review",
    path: "/plan",
    waitFor: 'button:has-text("Resume")',
    // The panel is a sheet over the plans list; Resume is what opens it at the
    // phase the session was left in, which the fixture pins to Review.
    prepare: [{ kind: "click", selector: 'button:has-text("Resume")' }],
    viewport: { width: 1280, height: 1000 },
    crop: { x: 512, y: 76, width: 768, height: 600 },
  },
  {
    id: "changes-queue",
    path: "/changes",
    waitFor: "text=/change pending in this project/",
    crop: { x: 150, y: 222, width: 980, height: 140 },
  },
  {
    id: "landing-not-landed",
    path: "/board",
    // The chip itself, not the column header - it is what the figure is of, and
    // it arrives last. Matched as a SUBSTRING (unquoted) because the chip's own
    // text continues into the reason, so an exact match resolves nothing.
    waitFor: "text=Not landed",
    // Wider than the board figure because Done is the SIXTH column: at 1760 it
    // is half off-screen, and a crop cannot recover what the viewport never
    // laid out.
    viewport: { width: 2200, height: 900 },
    crop: { x: 1700, y: 170, width: 340, height: 490 },
  },

  // ── Chapter 4 ─────────────────────────────────────────────────────────────
  {
    id: "skill-review",
    path: "/marketplace",
    waitFor: 'button:has-text("Review")',
    prepare: [{ kind: "click", selector: 'button:has-text("Review")' }],
    viewport: { width: 1280, height: 1000 },
    // The body is longer than any sensible frame, so this crop deliberately
    // ends inside it - but BETWEEN two lines rather than through one. A
    // boundary that bisects a row of glyphs reads as a broken render, where a
    // clean cut reads as "there is more of this".
    crop: { x: 256, y: 75, width: 768, height: 694 },
  },
  {
    id: "prompt-layers",
    path: "/agents/engineer",
    waitFor: "text=/How this agent/",
    crop: { x: 216, y: 246, width: 848, height: 372 },
  },
  {
    id: "lesson-review",
    path: "/learnings",
    waitFor: 'button:has-text("Accept")',
    // The card runs past the 800-high default, and a crop that does not fit is
    // silently clipped by the browser rather than refused - the first cut of
    // this figure lost its Accept and Reject buttons to exactly that. The
    // capture script now refuses instead; the viewport is what makes it fit.
    viewport: { width: 1280, height: 900 },
    crop: { x: 254, y: 342, width: 772, height: 490 },
  },
  {
    id: "safety-critical",
    // A THIRD ticket, so each drawer figure owns its own route. Sharing one
    // ticket across three figures would make any edit to that ticket's fixture
    // data reframe all three at once.
    path: `/board?ticket=${GUIDE_FIXTURE_IN_REVIEW_TICKET_ID}`,
    waitFor: 'button:has-text("Mark safety-critical")',
    viewport: { width: 1280, height: 1000 },
    crop: { x: 716, y: 306, width: 556, height: 124 },
  },
  {
    id: "run-cost-ceiling",
    // The SUCCEEDED run, not the failed one: a spend ceiling is a property of
    // every run, and photographing it on a failure would suggest the ceiling is
    // what stopped it.
    path: `/runs/${GUIDE_FIXTURE_RUN_ID}`,
    waitFor: "text=/of the per-run cap/",
    viewport: { width: 1280, height: 1000 },
    crop: { x: 88, y: 544, width: 280, height: 186 },
  },

  // ── Chapter 5 ─────────────────────────────────────────────────────────────
  {
    id: "settings-llm-auth",
    path: "/settings/llm-auth",
    waitFor: 'text="Claude Code subscription"',
    crop: { x: 16, y: 50, width: 1248, height: 332 },
  },
  {
    id: "platform-secret-shared",
    path: "/settings/platform-secrets",
    waitFor: 'text="Agents can read"',
    // Same reason as the branch-routing card: the row is far down a long page
    // and the clip is viewport-relative.
    viewport: { width: 1280, height: 2400 },
    crop: { x: 214, y: 1913, width: 858, height: 220 },
  },
  {
    id: "run-failed",
    path: `/runs/${GUIDE_FIXTURE_FAILED_RUN_ID}`,
    waitFor: "text=/timed out after/",
    viewport: { width: 1280, height: 1000 },
    crop: { x: 88, y: 143, width: 1104, height: 157 },
  },
];

/**
 * Figures considered and DELIBERATELY NOT captured, with the reason.
 *
 * Recorded because "why is there no screenshot of X" otherwise gets re-asked and
 * re-answered every time someone edits the guide - and because the first two are
 * refusals on determinism grounds that a future author would otherwise
 * rediscover the expensive way.
 */
export const GUIDE_FIGURES_DECLINED = [
  {
    subject: "The system-health card for the local runner",
    reason:
      "Its two most informative fields are a SERVER-rendered age ('last beat 3s ago') and a live DB round-trip latency ('7ms'). Both change on every capture, so the PNG diffs every run while the UI is identical - and a binary diff nobody can review is worse than no figure. Note the server-rendered part: the frozen browser clock cannot reach it. Cropping both away leaves a coloured dot and the word 'Operational', which a sentence carries perfectly well. RECONSIDERED when the guide went to a picture per screen, and re-declined: every card on that page carries its latency in the same row as its detail, so no rectangle separates them, and hiding the number with injected CSS would put a state in the manual that no reader will ever see. `settings-llm-auth` carries the settings tab strip instead.",
  },
  {
    subject: "The topbar system-status popover",
    reason: "Same volatile detail string, same conclusion.",
  },
  {
    subject: "The whole board page, including topbar and sidebar",
    reason:
      "Almost all of it is chrome the reader is already looking at, it carries more theme signal than anything else in the app, and every unrelated nav change would demand a recapture. The cropped columns make the same point in a fifth of the bytes.",
  },
  {
    subject: "A terminal showing the runner starting up",
    reason:
      "The section already prints the exact command in a copyable code block, which is strictly more useful than a picture of it.",
  },
  {
    subject: "The Runs LIST (the table of recent runs)",
    reason:
      "Its CREATED column renders an absolute local timestamp ('7/14/2026, 12:16:07 PM'), derived from a fixture offset, so it moves on every recapture - and the column sits in the middle of the table, where no crop can exclude it without cutting the row in half. The run INSPECTOR is the screen the guide actually sends you to, and `run-failed` and `run-cost-ceiling` photograph that.",
  },
  {
    subject: "The role-card grid on the Agents page",
    reason:
      "Each card's footer prints an absolute date for when the row was materialised, which for the fixture is the day it was seeded - so the figure would age even though nothing in the product changed. `handoff-chain` takes the strip above the grid, which is the part that actually teaches, and `prompt-layers` covers what is inside a role.",
  },
  {
    subject: "The Billing page",
    reason:
      "A local instance has no Stripe configured, so the page leads with a configuration warning and a balance of zero. A reader would take that as a picture of their own broken billing. The section's substance is the per-run ceiling, and `run-cost-ceiling` shows that where it is actually enforced.",
  },
  {
    subject: "The project-creation form",
    reason:
      "It is gated on a connected GitHub account, and a connection cannot be seeded: the access token is encrypted at the app layer with a key that differs per machine, so a fixture row would decrypt to nothing and read as not-connected anyway. Seeding one would also cost the `github-scopes` figure, which needs the not-connected state to list every scope. `integration-branch` covers the decision the form is actually making.",
  },
  {
    subject: "The glossary",
    reason:
      "It is definitions. There is no screen it teaches, and an image dropped in for symmetry would be decoration - which is the one thing a figure budget should never be spent on. It is also the section most likely to be read from the PDF while the app is misbehaving, where prose that stands alone is exactly right.",
  },
] as const;
