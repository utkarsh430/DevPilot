import Link from "next/link";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bot,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Cpu,
  Database,
  Gauge,
  GitMerge,
  HeartPulse,
  Landmark,
  Layers,
  Lock,
  Pause,
  Plug,
  Repeat,
  ShieldCheck,
  Sparkles,
  Store,
  Ticket,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DevPilotLogo } from "@/components/shell/devpilot-mark";

/**
 * DevPilot landing page — "the flight deck".
 *
 * A product pitch, not a spec sheet. The hero pairs the positioning statement
 * with a crafted cockpit panel (a board strip handing a ticket into a live run
 * trace), then the page walks the reader down the flight plan: how a ticket
 * flies, the pillars that make the system trustworthy, the guardrails compared
 * with a terminal loop, the crew, and the architecture. Every vignette is a
 * composed component rather than a screenshot, so it stays truthful across
 * themes and never rots.
 *
 * All color comes from the design tokens in globals.css; all motion is gated
 * behind prefers-reduced-motion via the dp-anim-* classes.
 */
export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <Backdrop />
      <SiteNav />
      <Hero />
      <StatsBand />
      <FlightPlan />
      <Pillars />
      <Guardrails />
      <Crew />
      <Architecture />
      <ClosingCta />
      <SiteFooter />
    </div>
  );
}

const GITHUB_URL = "https://github.com/utkarsh430/DevPilot";

/* ─── Backdrop ──────────────────────────────────────────────────────────────
 * A faint runway grid under the hero, fading out by the first fold, and one
 * warm glow in the signal color. Decorative; sits behind everything.
 */
function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[880px]" aria-hidden>
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.55)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.55)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_72%)]" />
      <div className="absolute left-1/2 top-[-140px] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,hsl(var(--primary)/0.14),transparent)] blur-2xl" />
    </div>
  );
}

/* ─── Chrome ───────────────────────────────────────────────────────────── */

function SiteNav() {
  return (
    <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
      <Link href="/" aria-label="DevPilot home" className="chrome-no-select">
        <DevPilotLogo />
      </Link>
      <nav className="flex items-center gap-1 text-sm">
        <Button asChild variant="ghost" size="sm">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </a>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/board">
            Open the board <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </Button>
      </nav>
    </header>
  );
}

/* ─── Hero ─────────────────────────────────────────────────────────────── */

const rise = (delay: string) => ({ "--dp-delay": delay }) as React.CSSProperties;

function Hero() {
  return (
    <section className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-14 px-6 pb-20 pt-12 sm:pt-20 lg:grid-cols-[minmax(0,11fr)_minmax(0,10fr)] lg:gap-10">
      <div>
        <div
          className="dp-anim-rise bg-card/70 text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.12em] backdrop-blur sm:tracking-[0.18em]"
          style={rise("0s")}
        >
          <span
            className="dp-anim-pulse bg-primary inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            aria-hidden
          />
          Agent orchestration runtime · MIT
        </div>

        <h1
          className="dp-anim-rise font-display mt-6 text-balance text-[2.75rem] font-extrabold leading-[1.02] tracking-[-0.03em] sm:text-6xl lg:text-[4.1rem]"
          style={rise("0.06s")}
        >
          Put your backlog on autopilot.
          <span className="text-primary block">Keep your hands on the controls.</span>
        </h1>

        <p
          className="dp-anim-rise text-muted-foreground mt-6 max-w-xl text-pretty text-base leading-relaxed sm:text-lg"
          style={rise("0.12s")}
        >
          DevPilot turns a kanban board into the runtime for a crew of AI agents. File a ticket; a
          PM scopes it, an Engineer builds it, QA breaks it, Security clears it, and the code lands
          on your integration branch — every step durable, budgeted, gated and traced, even while
          you are logged off.
        </p>

        <div className="dp-anim-rise mt-8 flex flex-col gap-3 sm:flex-row" style={rise("0.18s")}>
          <Button asChild size="lg">
            <Link href="/board">
              Open the board <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              Read the source <ArrowUpRight className="h-4 w-4" aria-hidden />
            </a>
          </Button>
        </div>

        <ul
          className="dp-anim-rise text-muted-foreground mt-10 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3"
          style={rise("0.24s")}
        >
          <ProofPoint icon={Cpu} text="Runs on your own Claude subscription" />
          <ProofPoint icon={Pause} text="Pauses for days, resumes from the exact step" />
          <ProofPoint icon={Lock} text="MIT licensed, self-hostable in one command" />
        </ul>
      </div>

      <FlightDeck />
    </section>
  );
}

function ProofPoint({
  icon: Icon,
  text,
}: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon className="text-primary mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="leading-snug">{text}</span>
    </li>
  );
}

/* ─── The flight deck — board strip + live trace, one composed panel ─────── */

type RoleTone = "pm" | "eng" | "qa" | "sec";

const ROLE_CHIP: Record<RoleTone, string> = {
  pm: "bg-chart-1/15 text-chart-1",
  eng: "bg-chart-4/15 text-chart-4",
  qa: "bg-chart-2/15 text-chart-2",
  sec: "bg-chart-5/15 text-chart-5",
};

const ROLE_BAR: Record<RoleTone | "tool", string> = {
  pm: "bg-chart-1",
  eng: "bg-chart-4",
  qa: "bg-chart-2",
  sec: "bg-chart-5",
  tool: "bg-muted-foreground/40",
};

type DeckCard = { id: string; title: string; role?: { label: string; tone: RoleTone } };

const DECK_COLUMNS: { name: string; cards: DeckCard[] }[] = [
  {
    name: "Ready",
    cards: [
      { id: "DP-118", title: "Rate-limit the invite endpoint" },
      { id: "DP-119", title: "Empty state for the runs page", role: { label: "PM", tone: "pm" } },
    ],
  },
  {
    name: "In progress",
    cards: [
      { id: "DP-114", title: "Migrate billing webhooks", role: { label: "ENG", tone: "eng" } },
    ],
  },
  {
    name: "In review",
    cards: [
      { id: "DP-115", title: "Wire up the audit log export", role: { label: "QA", tone: "qa" } },
      { id: "DP-112", title: "Audit the OAuth callback", role: { label: "SEC", tone: "sec" } },
    ],
  },
];

const DECK_TRACE: {
  label: string;
  tone: RoleTone | "tool";
  left: number;
  width: number;
  dur: string;
}[] = [
  { label: "engineer · implement", tone: "eng", left: 0, width: 46, dur: "3m 12s" },
  { label: "tool · pnpm test", tone: "tool", left: 24, width: 14, dur: "41s" },
  { label: "gate · build verified", tone: "tool", left: 46, width: 6, dur: "4s" },
  { label: "qa · review & verdict", tone: "qa", left: 54, width: 30, dur: "1m 44s" },
  { label: "land · squash onto dev", tone: "sec", left: 86, width: 14, dur: "19s" },
];

function FlightDeck() {
  return (
    <div className="dp-anim-rise relative" style={rise("0.1s")} aria-hidden>
      <div className="bg-card overflow-hidden rounded-2xl border shadow-[0_32px_80px_-36px_hsl(var(--foreground)/0.45)]">
        {/* Title bar */}
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="bg-border h-2.5 w-2.5 rounded-full" />
            <span className="bg-border h-2.5 w-2.5 rounded-full" />
            <span className="bg-border h-2.5 w-2.5 rounded-full" />
            <span className="text-muted-foreground ml-3 font-mono text-[10px]">
              devpilot · project/olympus · board
            </span>
          </div>
          <span className="bg-success/10 text-success flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px]">
            <span className="dp-anim-pulse bg-success inline-block h-1.5 w-1.5 rounded-full" />2
            agents working
          </span>
        </div>

        {/* Board strip */}
        <div className="bg-border grid grid-cols-3 gap-px">
          {DECK_COLUMNS.map((col) => (
            <div key={col.name} className="bg-card min-h-[150px] p-2.5">
              <div className="mb-2 flex items-center justify-between px-0.5">
                <span className="text-muted-foreground font-mono text-[9px] font-medium uppercase tracking-[0.14em]">
                  {col.name}
                </span>
                <span className="bg-muted text-muted-foreground rounded-full px-1.5 font-mono text-[9px]">
                  {col.cards.length}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {col.cards.map((card) => (
                  <div key={card.id} className="bg-background/70 rounded-md border p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground font-mono text-[9px]">{card.id}</span>
                      {card.role ? (
                        <span
                          className={`rounded px-1 py-px font-mono text-[8px] font-semibold ${ROLE_CHIP[card.role.tone]}`}
                        >
                          {card.role.label}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-[10.5px] font-medium leading-snug">{card.title}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Live trace. Extra bottom room from `sm` up is the lane the verdict
            chip below hangs into, so it never covers a trace row. */}
        <div className="border-t p-4 sm:pb-16">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-muted-foreground font-mono text-[10px]">
              run_01hx4 · DP-115 · wire up the audit log export
            </span>
            <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
              $0.42 / $5.00
            </span>
          </div>
          <div className="flex flex-col gap-[6px]">
            {DECK_TRACE.map((row, i) => (
              <div
                key={row.label}
                className="grid grid-cols-[132px_minmax(0,1fr)_48px] items-center gap-3"
              >
                <span className="text-muted-foreground truncate font-mono text-[9.5px]">
                  {row.label}
                </span>
                <div className="relative h-[8px]">
                  <div
                    className={`dp-anim-bar absolute inset-y-0 origin-left rounded-full ${ROLE_BAR[row.tone]}`}
                    style={
                      {
                        left: `${row.left}%`,
                        width: `${row.width}%`,
                        "--dp-delay": `${0.5 + i * 0.1}s`,
                      } as React.CSSProperties
                    }
                  />
                </div>
                <span className="text-muted-foreground text-right font-mono text-[9.5px] tabular-nums">
                  {row.dur}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* The verdict chip — the hand-off that just happened, lifted off the deck.
          Hidden on phones, where the deck has no clear lane for it. */}
      <div className="dp-anim-drift absolute -bottom-4 -right-6 hidden w-[220px] rotate-2 sm:block">
        <div className="border-primary/40 bg-card ring-primary/20 rounded-lg border p-3 shadow-xl ring-4">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground font-mono text-[9px]">DP-115 · qa</span>
            <span
              className={`rounded px-1 py-px font-mono text-[8px] font-semibold ${ROLE_CHIP.qa}`}
            >
              VERDICT
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium">
            <CheckCircle2 className="text-success h-3.5 w-3.5" />
            Approved — 311/311 tests green
          </div>
          <div className="text-primary mt-1 font-mono text-[9px]">→ landing on dev</div>
        </div>
      </div>
    </div>
  );
}

/* ─── Stats band ─────────────────────────────────────────────────────────── */

const STATS: { value: string; label: string }[] = [
  { value: "53", label: "built-in roles" },
  { value: "10", label: "board tools over MCP" },
  { value: "110", label: "forward-only migrations" },
  { value: "40+", label: "durable functions" },
  { value: "4,100+", label: "tests gating every commit" },
];

function StatsBand() {
  return (
    <section className="bg-card/40 border-y">
      <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-px px-6 py-8 sm:grid-cols-5">
        {STATS.map((s) => (
          <div key={s.label} className="py-3 sm:text-center">
            <dd className="font-display text-3xl font-extrabold tabular-nums tracking-tight">
              {s.value}
            </dd>
            <dt className="text-muted-foreground mt-1 font-mono text-[11px] uppercase tracking-[0.14em]">
              {s.label}
            </dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ─── Flight plan — how a ticket flies ───────────────────────────────────── */

const FLIGHT_PLAN: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  text: string;
}[] = [
  {
    icon: Ticket,
    title: "File it",
    text: "A title, acceptance criteria, attachments and dependencies. Moving the card to Ready is what starts the machine — the board is the scheduler.",
  },
  {
    icon: Workflow,
    title: "Dispatch, durably",
    text: "Budget, WIP and spawn caps are checked before anything runs. The run is a chain of checkpointed steps that resumes after a crash or a multi-day pause.",
  },
  {
    icon: ShieldCheck,
    title: "Hand off, gated",
    text: "PM → Engineer → QA → Security. A failing build or an empty delivery cannot reach review; a reviewer cannot finish without recording a verdict.",
  },
  {
    icon: GitMerge,
    title: "Land it",
    text: "Approved work is rebased and squash-merged onto your integration branch, and dependents are released the moment the code is actually there.",
  },
];

function FlightPlan() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <SectionHeading
        eyebrow="Flight plan"
        title="How a ticket flies."
        lede="Agents coordinate by moving tickets and writing comments — so every hand-off is durable, inspectable and resumable by construction."
      />
      <ol className="relative mt-14 grid grid-cols-1 gap-10 lg:grid-cols-4 lg:gap-6">
        <div
          className="bg-border absolute left-[19px] top-2 hidden h-[calc(100%-1rem)] w-px lg:left-0 lg:top-[19px] lg:block lg:h-px lg:w-full"
          aria-hidden
        />
        {FLIGHT_PLAN.map((step, i) => (
          <li key={step.title} className="relative flex gap-5 lg:block">
            <div className="bg-background relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border">
              <span className="text-primary font-mono text-xs font-semibold">
                {String(i + 1).padStart(2, "0")}
              </span>
            </div>
            <div className="lg:mt-5">
              <div className="flex items-center gap-2">
                <step.icon className="text-primary h-4 w-4" aria-hidden />
                <h3 className="font-display text-lg font-bold tracking-tight">{step.title}</h3>
              </div>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ─── Pillars — a bento of what makes it trustworthy ─────────────────────── */

function Pillars() {
  return (
    <section className="bg-card/40 border-y">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <SectionHeading
          eyebrow="Why it holds"
          title="Built on structure, not on prompts."
          lede="Every hard problem of autonomous agents — durability, cost, trust, verification, recovery — is solved by a named mechanism you can read, not by hoping the model behaves."
        />

        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-6">
          {/* Durable */}
          <PillarCard className="md:col-span-4" icon={Repeat} title="Durable by construction">
            <p>
              Every iteration and tool call is a checkpointed step. A run can wait days on your
              reply and resume from exactly where it stopped; a runner that shuts down puts its
              in-flight job back on the queue.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2 font-mono text-[10px]">
              <Step label="think" />
              <Dash />
              <Step label="tool · git" />
              <Dash />
              <Step label="tool · pnpm test" />
              <Dash />
              <Step label="paused 3d · human reply" tone="hold" />
              <Dash />
              <Step label="resume" tone="live" />
              <Dash />
              <Step label="in_review" />
            </div>
          </PillarCard>

          {/* Ceilings */}
          <PillarCard className="md:col-span-2" icon={Landmark} title="Hard ceilings">
            <p>
              Per-run budgets re-checked at every step boundary, a tenant-wide cost-velocity breaker
              no override can bypass, and recursion, fan-out and total-agent caps on every spawn.
            </p>
            <div className="mt-5">
              <div className="flex items-center justify-between font-mono text-[10px]">
                <span className="text-muted-foreground">run budget</span>
                <span className="tabular-nums">$2.10 / $5.00</span>
              </div>
              <div className="bg-muted mt-1.5 h-2 overflow-hidden rounded-full">
                <div className="bg-primary h-full w-[42%] rounded-full" />
              </div>
              <div className="text-muted-foreground mt-2 flex items-center gap-1.5 font-mono text-[10px]">
                <Gauge className="h-3 w-3" aria-hidden /> velocity breaker armed
              </div>
            </div>
          </PillarCard>

          {/* Gated done */}
          <PillarCard className="md:col-span-2" icon={CheckCircle2} title="Done is gated">
            <ul className="space-y-2 text-sm">
              <Gate text="No hand-off with a failing build" />
              <Gate text="No hand-off with nothing committed" />
              <Gate text="No review ends without a verdict" />
              <Gate text="Safety-critical tickets need a human to close" />
            </ul>
          </PillarCard>

          {/* Self-healing */}
          <PillarCard
            className="md:col-span-2"
            icon={HeartPulse}
            title="Self-healing, with a ledger"
          >
            <p>
              Stranded tickets, lost dispatch events and dead runs are detected from database facts
              and repaired. Every fix is recorded with its cause, and repeats are flagged as a
              defect.
            </p>
            <ul className="text-muted-foreground mt-4 space-y-1 font-mono text-[10px]">
              <li>• ticket reconciler · stuck sweeper</li>
              <li>• orphan reaper · dispatch rescue</li>
              <li>• supervisor, outside the scheduler</li>
            </ul>
          </PillarCard>

          {/* Trace */}
          <PillarCard className="md:col-span-2" icon={Activity} title="The trace is the product">
            <p>
              A wall-clock waterfall of every think, tool and model step with its cost — live,
              replayable from any step, exportable as an audit-grade PDF.
            </p>
            <div className="mt-4 flex flex-col gap-1.5">
              {[
                ["pm", 0, 18],
                ["eng", 16, 44],
                ["tool", 30, 12],
                ["qa", 60, 26],
                ["sec", 86, 14],
              ].map(([tone, left, width], i) => (
                <div key={i} className="relative h-[6px]">
                  <div
                    className={`dp-anim-bar absolute inset-y-0 origin-left rounded-full ${ROLE_BAR[tone as RoleTone | "tool"]}`}
                    style={
                      {
                        left: `${left}%`,
                        width: `${width}%`,
                        "--dp-delay": `${i * 0.08}s`,
                      } as React.CSSProperties
                    }
                  />
                </div>
              ))}
            </div>
          </PillarCard>

          {/* Runner-first */}
          <PillarCard className="md:col-span-3" icon={Cpu} title="Runner-first, your model">
            <p>
              The default runner executes steps on your own Claude Pro/Max subscription with the
              full Claude Code toolset. Switch to the API runner, or point a project at any
              OpenAI-compatible endpoint — same board, same gates.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 font-mono text-[10px]">
              <span className="bg-primary/10 text-primary border-primary/30 rounded-full border px-2.5 py-1">
                claude -p · your subscription · default
              </span>
              <span className="text-muted-foreground rounded-full border px-2.5 py-1">
                API runner · per token
              </span>
              <span className="text-muted-foreground rounded-full border px-2.5 py-1">
                custom endpoint · per project
              </span>
            </div>
          </PillarCard>

          {/* Learning */}
          <PillarCard
            className="md:col-span-3"
            icon={Sparkles}
            title="Agents that learn — under review"
          >
            <p>
              Failures are harvested into a mistake record, drafted into candidate lessons, graded
              for confidence, and shown to you. Only lessons you approve reach the agents, as fenced
              data — never as instructions that outrank the role.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[10px]">
              <Step label="mistake" />
              <Dash />
              <Step label="candidate lesson" />
              <Dash />
              <Step label="your review" tone="hold" />
              <Dash />
              <Step label="active" tone="live" />
            </div>
          </PillarCard>
        </div>
      </div>
    </section>
  );
}

function PillarCard({
  icon: Icon,
  title,
  className = "",
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`bg-card hover:border-primary/40 rounded-xl border p-6 transition-colors ${className}`}
    >
      <div className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <h3 className="font-display text-lg font-bold tracking-tight">{title}</h3>
      </div>
      <div className="text-muted-foreground mt-4 text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function Step({ label, tone = "plain" }: { label: string; tone?: "plain" | "hold" | "live" }) {
  const cls =
    tone === "hold"
      ? "border-warning/40 bg-warning/10 text-warning"
      : tone === "live"
        ? "border-success/40 bg-success/10 text-success"
        : "text-muted-foreground border";
  return <span className={`rounded-md border px-2 py-1 ${cls}`}>{label}</span>;
}

function Dash() {
  return <span className="bg-border h-px w-3 shrink-0" aria-hidden />;
}

function Gate({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2 className="text-success mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{text}</span>
    </li>
  );
}

/* ─── Guardrails — the comparison ────────────────────────────────────────── */

const COMPARISON: { before: string; after: string }[] = [
  {
    before: "Agents coordinate through in-memory messages that die with the run.",
    after: "Agents coordinate on the board — every hand-off is a durable, inspectable record.",
  },
  {
    before: "A crash, a restart or a closed laptop loses the work.",
    after: "Every step is checkpointed; runs resume after restarts and multi-day pauses.",
  },
  {
    before: "Cost is discovered on the invoice.",
    after: "Ceilings are enforced before spend, at every step, with a shared circuit breaker.",
  },
  {
    before: "“Done” means the model said so.",
    after:
      "Done is gated on verified builds, real deliveries, recorded verdicts and human approval.",
  },
  {
    before: "A stuck job needs a human with a database console.",
    after: "Four independent healers repair stranded work and keep a ledger of why it happened.",
  },
];

function Guardrails() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <SectionHeading
        eyebrow="Guardrails"
        title="A terminal loop versus a runtime."
        lede="The difference between a demo and a system you can leave running overnight."
      />
      <div className="mt-12 overflow-hidden rounded-xl border">
        <div className="bg-card/60 text-muted-foreground grid grid-cols-1 border-b font-mono text-[10px] uppercase tracking-[0.18em] md:grid-cols-2">
          <div className="px-6 py-3">Ordinary agent tooling</div>
          <div className="text-primary border-t px-6 py-3 md:border-l md:border-t-0">DevPilot</div>
        </div>
        <ul className="divide-y">
          {COMPARISON.map((row) => (
            <li key={row.after} className="grid grid-cols-1 md:grid-cols-2">
              <div className="text-muted-foreground px-6 py-5 text-sm">{row.before}</div>
              <div className="bg-card flex items-start gap-3 border-t px-6 py-5 text-sm md:border-l md:border-t-0">
                <CheckCircle2 className="text-success mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{row.after}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ─── The crew ───────────────────────────────────────────────────────────── */

const CREW: { name: string; tone: RoleTone | "ops" | "plain" }[] = [
  { name: "Product Manager", tone: "pm" },
  { name: "Engineer", tone: "eng" },
  { name: "Frontend Engineer", tone: "eng" },
  { name: "Backend Engineer", tone: "eng" },
  { name: "Fullstack Engineer", tone: "eng" },
  { name: "Mobile Engineer", tone: "eng" },
  { name: "QA", tone: "qa" },
  { name: "SDET", tone: "qa" },
  { name: "Verifier", tone: "qa" },
  { name: "Security", tone: "sec" },
  { name: "AppSec Engineer", tone: "sec" },
  { name: "Release Engineer", tone: "ops" },
  { name: "DevOps", tone: "ops" },
  { name: "SRE", tone: "ops" },
  { name: "DBA", tone: "ops" },
  { name: "Data Engineer", tone: "plain" },
  { name: "Data Scientist", tone: "plain" },
  { name: "ML Engineer", tone: "plain" },
  { name: "Software Architect", tone: "plain" },
  { name: "Staff Engineer", tone: "plain" },
  { name: "Technical Writer", tone: "plain" },
  { name: "UX Designer", tone: "plain" },
  { name: "Scrum Master", tone: "plain" },
  { name: "Triage", tone: "plain" },
];

const CREW_CHIP: Record<RoleTone | "ops" | "plain", string> = {
  pm: "border-chart-1/30 bg-chart-1/10 text-chart-1",
  eng: "border-chart-4/30 bg-chart-4/10 text-chart-4",
  qa: "border-chart-2/30 bg-chart-2/10 text-chart-2",
  sec: "border-chart-5/30 bg-chart-5/10 text-chart-5",
  ops: "border-chart-3/30 bg-chart-3/10 text-chart-3",
  plain: "bg-card text-foreground/80",
};

function Crew() {
  return (
    <section className="bg-card/40 border-y">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-6 py-24 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div>
          <SectionHeading
            eyebrow="The crew"
            title="53 roles. One board."
            lede="Each role ships with a prompt split into style guidance you can overlay and a safety contract no overlay can touch. Describe a job and DevPilot drafts a new role; install skills; approve lessons — every layer is applied at dispatch and nothing is baked into stored config."
          />
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button asChild variant="outline">
              <Link href="/agents">
                Meet the crew <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap content-start gap-2">
          {CREW.map((r) => (
            <span
              key={r.name}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium ${CREW_CHIP[r.tone]}`}
            >
              {r.name}
            </span>
          ))}
          <span className="text-muted-foreground rounded-full border border-dashed px-3 py-1.5 text-xs">
            + 29 more, or describe your own
          </span>
        </div>
      </div>
    </section>
  );
}

/* ─── Architecture ───────────────────────────────────────────────────────── */

const ARCH: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  text: string;
}[] = [
  {
    icon: Layers,
    title: "Board",
    text: "Tickets, comments and relations in Postgres with row-level security on every table.",
  },
  {
    icon: Workflow,
    title: "Durable engine",
    text: "40+ Inngest functions: dispatcher, run loop, gates, landing pipeline, reapers, supervisor.",
  },
  {
    icon: Bot,
    title: "Runner",
    text: "A resident worker: isolated git workspace per ticket, claude -p with board tools over MCP, verification, trace.",
  },
  {
    icon: Database,
    title: "Your repo",
    text: "Per-ticket branches, review-before-push, auto-land onto the integration branch, Vercel deploy and rollback.",
  },
];

function Architecture() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <SectionHeading
        eyebrow="Architecture"
        title="Four parts, one contract."
        lede="The LLM is the only hard dependency. Everything else is open-source-first and replaceable behind one Runner interface."
      />
      <ol className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ARCH.map((part, i) => (
          <li key={part.title} className="bg-card relative rounded-xl border p-6">
            <div className="flex items-center justify-between">
              <span className="bg-background text-primary flex h-9 w-9 items-center justify-center rounded-lg border">
                <part.icon className="h-4 w-4" aria-hidden />
              </span>
              {i < ARCH.length - 1 ? (
                <ArrowRight
                  className="text-muted-foreground/50 hidden h-4 w-4 lg:block"
                  aria-hidden
                />
              ) : null}
            </div>
            <h3 className="font-display mt-4 text-lg font-bold tracking-tight">{part.title}</h3>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{part.text}</p>
          </li>
        ))}
      </ol>
      <div className="mt-8 flex flex-col gap-3 rounded-xl border border-dashed px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-[0.22em]">
          Under the hood
        </span>
        <p className="text-muted-foreground font-mono text-[11px] leading-relaxed">
          Next.js · Supabase Postgres + RLS · Inngest · Upstash Redis · Claude Agent SDK · MCP ·
          Langfuse · Promptfoo
        </p>
      </div>
      <ul className="text-muted-foreground mt-8 grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        <ProofPoint
          icon={CalendarClock}
          text="Schedules, plan sessions and a stack advisor that commit real tickets"
        />
        <ProofPoint
          icon={Store}
          text="A skills marketplace with a pre-install scanner and provenance tracking"
        />
        <ProofPoint
          icon={Plug}
          text="Headless API, OpenAI-compatible endpoint and an embeddable widget"
        />
      </ul>
    </section>
  );
}

/* ─── Closing CTA + footer ───────────────────────────────────────────────── */

function ClosingCta() {
  return (
    <section className="bg-card/40 border-t">
      <div className="mx-auto max-w-4xl px-6 py-24 text-center">
        <h2 className="font-display text-balance text-4xl font-extrabold tracking-tight sm:text-5xl">
          Ship from a board, not a terminal.
        </h2>
        <p className="text-muted-foreground mx-auto mt-4 max-w-lg text-balance text-base">
          One command brings up the whole stack on your machine. File your first ticket and watch
          the crew take it to Done.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link href="/board">
              Open the board <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <BookOpen className="h-4 w-4" aria-hidden /> Quick start on GitHub
            </a>
          </Button>
        </div>
        <pre className="bg-card text-muted-foreground mx-auto mt-8 w-fit max-w-full overflow-x-auto rounded-lg border px-5 py-3 text-left font-mono text-[12px] leading-relaxed">
          {`git clone ${GITHUB_URL}.git && cd DevPilot
pnpm install && pnpm setup:local && pnpm dev:local`}
        </pre>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="text-muted-foreground mx-auto flex max-w-6xl flex-col items-center gap-3 px-6 py-8 text-xs sm:flex-row sm:justify-between">
        <div className="flex items-center gap-3">
          <DevPilotLogo className="[&>span:last-child]:text-sm" markClassName="h-4 w-4" />
          <span className="hidden sm:inline">the board your agents run</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/board" className="hover:text-foreground transition-colors">
            Board
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground transition-colors"
          >
            GitHub
          </a>
          <a
            href={`${GITHUB_URL}/blob/main/LICENSE`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground transition-colors"
          >
            MIT License
          </a>
          <Link href="/login" className="hover:text-foreground transition-colors">
            Sign in
          </Link>
        </div>
      </div>
    </footer>
  );
}

/* ─── Shared bits ────────────────────────────────────────────────────────── */

function SectionHeading({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede: string;
}) {
  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-2.5">
        <span
          className="bg-primary inline-block h-[7px] w-[11px] -rotate-6 rounded-[2px]"
          aria-hidden
        />
        <span className="text-muted-foreground font-mono text-[11px] font-medium uppercase tracking-[0.25em]">
          {eyebrow}
        </span>
      </div>
      <h2 className="font-display mt-4 text-balance text-3xl font-extrabold tracking-tight sm:text-4xl">
        {title}
      </h2>
      <p className="text-muted-foreground mt-4 text-pretty text-base leading-relaxed">{lede}</p>
    </div>
  );
}
