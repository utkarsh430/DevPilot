"use client";

// Phase 1 / M11 — client-side marketplace catalog. Renders the full grid +
// filter + search + tabs experience on top of the listings the server page
// has already fetched. Keeps the page itself a server component so auth +
// DB reads still happen at render time.
//
// Why this lives client-side:
//   - Filter chips + search are instant interactions; bouncing through the
//     server for each keystroke would feel sluggish.
//   - The install/uninstall buttons need transitions + toast feedback.
//
// The catalog UI is split into a "Skills" grid (the primary surface) and a
// "Tool packages" grid (smaller — Phase 1 only persists their manifests).
// Both share the same card scaffold via <ListingCard>.

import * as React from "react";
import {
  Sparkles,
  Search,
  Check,
  PackageOpen,
  ShieldCheck,
  Wrench,
  FileCode,
  Loader2,
  Inbox,
  ScanEye,
  Zap,
  PenLine,
  RotateCcw,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import type { SkillRow, ToolPackageRow } from "@/lib/skills/types";
import { SkillPreview } from "@/components/marketplace/skill-preview";
import { SkillScan } from "@/components/marketplace/skill-scan";
import { SkillEditLink } from "@/components/marketplace/skill-edit-link";
import {
  SkillProvenanceBadge,
  SkillProvenanceNote,
} from "@/components/marketplace/skill-provenance-note";
import {
  classifySkillOrigin,
  describeBodySize,
  describeSkillReach,
  describeSkillTriggers,
  originLabel,
} from "@/lib/marketplace/skill-view";
import {
  classifySkillProvenance,
  describeCatalogResetOffer,
} from "@/lib/marketplace/skill-provenance";
import { resetSkillToCatalogAction } from "@/lib/skills/authoring-actions";
import {
  installSkillAction,
  installToolPackageAction,
  uninstallSkillAction,
  uninstallToolPackageAction,
} from "./actions";

type Kind = "skill" | "tool_package";

// Maps the 5 chart accents we expose in globals.css onto a stable set of
// roles. Anything outside this set falls through to `default`, which uses the
// neutral secondary tone.
const ROLE_COLOR: Record<string, string> = {
  pm: "text-chart-1 border-chart-1/30 bg-chart-1/10",
  engineer: "text-chart-2 border-chart-2/30 bg-chart-2/10",
  qa: "text-chart-3 border-chart-3/30 bg-chart-3/10",
  security: "text-chart-5 border-chart-5/30 bg-chart-5/10",
  devops: "text-chart-4 border-chart-4/30 bg-chart-4/10",
  techwriter: "text-chart-1 border-chart-1/30 bg-chart-1/10",
  designer: "text-chart-4 border-chart-4/30 bg-chart-4/10",
  dataeng: "text-chart-2 border-chart-2/30 bg-chart-2/10",
  triage: "text-chart-3 border-chart-3/30 bg-chart-3/10",
  tech_lead: "text-chart-5 border-chart-5/30 bg-chart-5/10",
};

// Fallback labels for the handful of chart-accented roles. The full slug →
// display-name map is threaded down from the server (`roleLabels`, sourced from
// `lib/roles/catalog.ts`) so every role — not just these ten — shows a friendly
// name; this local map only backstops the color-swatch roles if that prop is
// ever absent.
const ROLE_LABEL: Record<string, string> = {
  pm: "PM",
  engineer: "Engineer",
  qa: "QA",
  security: "Security",
  devops: "DevOps",
  techwriter: "Tech Writer",
  designer: "Designer",
  dataeng: "Data Eng",
  triage: "Triage",
  tech_lead: "Tech Lead",
};

type CatalogProps = {
  publicSkills: SkillRow[];
  installedSkills: SkillRow[];
  publicToolPackages: ToolPackageRow[];
  installedToolPackages: ToolPackageRow[];
  /**
   * The caller's tenant. Ownership — and therefore whether an Edit affordance
   * is offered at all — is decided against this, never against a truthy
   * `tenant_id`: a public row and a foreign row are both "not ours" and must
   * both stay read-only.
   */
  tenantId: string;
  /** slug → display name, sourced from the role catalog on the server. */
  roleLabels?: Record<string, string>;
};

export function MarketplaceCatalog({
  publicSkills,
  installedSkills,
  publicToolPackages,
  installedToolPackages,
  tenantId,
  roleLabels,
}: CatalogProps) {
  const labelFor = React.useCallback(
    (slug: string): string => roleLabels?.[slug] ?? ROLE_LABEL[slug] ?? slug,
    [roleLabels],
  );
  const [query, setQuery] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState<string>("all");

  // Build the source->installed lookups once. The DB query already filtered
  // to public rows (server) so any `installed_from_skill_id` is a stable key
  // into the public set.
  const installedSkillBySource = React.useMemo(
    () =>
      new Map(
        installedSkills
          .filter((s) => s.installed_from_skill_id)
          .map((s) => [s.installed_from_skill_id as string, s]),
      ),
    [installedSkills],
  );
  const installedToolBySource = React.useMemo(
    () =>
      new Map(
        installedToolPackages
          .filter((t) => t.installed_from_tool_package_id)
          .map((t) => [t.installed_from_tool_package_id as string, t]),
      ),
    [installedToolPackages],
  );

  // Reverse lookup, for the Installed tab: a clone needs its public source to
  // be compared against.
  const publicSkillById = React.useMemo(
    () => new Map(publicSkills.map((s) => [s.id, s])),
    [publicSkills],
  );

  // Surface all roles that show up on at least one skill so the chip row
  // self-prunes to the actually-useful filters.
  const visibleRoles = React.useMemo(() => {
    const set = new Set<string>();
    for (const s of publicSkills) for (const t of s.targets ?? []) set.add(t);
    return Array.from(set).sort();
  }, [publicSkills]);

  const lowerQ = query.trim().toLowerCase();
  function matchesQuery(name: string, summary: string): boolean {
    if (!lowerQ) return true;
    return name.toLowerCase().includes(lowerQ) || summary.toLowerCase().includes(lowerQ);
  }
  function matchesRole(targets: string[]): boolean {
    if (roleFilter === "all") return true;
    // An empty targets list means EVERY role at dispatch (`keywordFilter`,
    // lib/skills/select.ts), so a role filter must include those skills — they
    // genuinely do attach to the role being filtered for. Excluding them, as
    // this did, hid the widest-reaching skills behind every narrowing filter.
    if (describeSkillReach(targets).allRoles) return true;
    return targets.includes(roleFilter);
  }

  const filteredAvailableSkills = publicSkills.filter(
    (s) => matchesQuery(s.name, summaryOf(s.manifest)) && matchesRole(s.targets ?? []),
  );
  const filteredInstalledSkills = installedSkills.filter(
    (s) => matchesQuery(s.name, summaryOf(s.manifest)) && matchesRole(s.targets ?? []),
  );

  const filteredAvailableTools = publicToolPackages.filter((t) =>
    matchesQuery(t.name, summaryOf(t.manifest)),
  );
  const filteredInstalledTools = installedToolPackages.filter((t) =>
    matchesQuery(t.name, summaryOf(t.manifest)),
  );

  const authoredSkills = filteredInstalledSkills.filter(
    (s) => classifySkillOrigin(s) === "authored",
  );
  const clonedSkills = filteredInstalledSkills.filter(
    (s) => classifySkillOrigin(s) === "installed",
  );

  const availableCount = filteredAvailableSkills.length + filteredAvailableTools.length;
  const installedCount = filteredInstalledSkills.length + filteredInstalledTools.length;

  return (
    <div className="flex flex-col gap-6">
      {/* Search + role chips */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full max-w-md">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills and packages…"
            className="pl-9"
            aria-label="Search skills and tool packages"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <RoleChip
            label="All"
            active={roleFilter === "all"}
            onClick={() => setRoleFilter("all")}
          />
          {visibleRoles.map((r) => (
            <RoleChip
              key={r}
              label={labelFor(r)}
              active={roleFilter === r}
              onClick={() => setRoleFilter(r)}
              swatchClass={ROLE_COLOR[r]}
            />
          ))}
        </div>
      </div>

      <Tabs defaultValue="available">
        <TabsList>
          <TabsTrigger value="available" className="gap-2">
            <PackageOpen className="h-3.5 w-3.5" />
            Available
            <span className="bg-background/70 text-muted-foreground ml-1 rounded-sm px-1.5 py-0.5 text-[10px] tabular-nums">
              {availableCount}
            </span>
          </TabsTrigger>
          <TabsTrigger value="installed" className="gap-2">
            <Check className="h-3.5 w-3.5" />
            Installed
            <span className="bg-background/70 text-muted-foreground ml-1 rounded-sm px-1.5 py-0.5 text-[10px] tabular-nums">
              {installedCount}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="available" className="space-y-8">
          <Section
            title="Skills"
            description="Skill bodies are merged into role system prompts at dispatch. They are prompt content — not executable code."
          >
            {filteredAvailableSkills.length === 0 ? (
              <EmptyState
                icon={<Sparkles className="h-5 w-5" />}
                title={
                  query || roleFilter !== "all" ? "No matching skills" : "No public skills yet"
                }
                hint={
                  query || roleFilter !== "all"
                    ? "Try clearing your filters or search terms."
                    : "Run the M11 seed migration to populate the first-party catalog."
                }
              />
            ) : (
              <Grid>
                {filteredAvailableSkills.map((s) => {
                  const installed = installedSkillBySource.get(s.id) ?? null;
                  return (
                    <SkillCard key={s.id} skill={s} installed={installed} labelFor={labelFor} />
                  );
                })}
              </Grid>
            )}
          </Section>

          <Section
            title="Tool packages"
            description="Phase 1 persists manifests only. Runtime wiring (MCP discovery, dynamic tool registration) ships later."
          >
            {filteredAvailableTools.length === 0 ? (
              <EmptyState
                icon={<Wrench className="h-5 w-5" />}
                title={query ? "No matching tool packages" : "No public tool packages yet"}
                hint={
                  query ? "Try a different search." : "Check back after the M12 wiring milestone."
                }
              />
            ) : (
              <Grid>
                {filteredAvailableTools.map((t) => {
                  const installed = installedToolBySource.get(t.id);
                  return <ToolPackageCard key={t.id} pkg={t} installedId={installed?.id ?? null} />;
                })}
              </Grid>
            )}
          </Section>
        </TabsContent>

        <TabsContent value="installed" className="space-y-8">
          {installedCount === 0 ? (
            <EmptyState
              icon={<Inbox className="h-5 w-5" />}
              title="Nothing installed in this tenant"
              hint="Install from the Available tab, or publish a skill of your own."
            />
          ) : (
            <>
              {/*
                Authored and installed rows are BOTH tenant-owned and used to
                render identically, which hid the one difference that matters:
                an authored skill has no upstream to compare against and is the
                tenant's own text, while an installed one is a clone that can
                drift from the public source. They get separate sections so the
                operator can see at a glance how much of their catalog is
                locally written prompt content.
              */}
              {authoredSkills.length > 0 && (
                <Section
                  title="Authored here"
                  description="Written in this tenant. Not from the public catalog — nobody else reviewed this text."
                >
                  <Grid>
                    {authoredSkills.map((s) => (
                      <InstalledSkillCard
                        key={s.id}
                        skill={s}
                        source={null}
                        tenantId={tenantId}
                        labelFor={labelFor}
                      />
                    ))}
                  </Grid>
                </Section>
              )}
              {clonedSkills.length > 0 && (
                <Section
                  title="Installed from the catalog"
                  description="Clones of public entries. DevPilot flags one whose body no longer matches its source."
                >
                  <Grid>
                    {clonedSkills.map((s) => (
                      <InstalledSkillCard
                        key={s.id}
                        skill={s}
                        source={publicSkillById.get(s.installed_from_skill_id as string) ?? null}
                        tenantId={tenantId}
                        labelFor={labelFor}
                      />
                    ))}
                  </Grid>
                </Section>
              )}
              {filteredInstalledTools.length > 0 && (
                <Section title="Installed tool packages">
                  <Grid>
                    {filteredInstalledTools.map((t) => (
                      <InstalledToolPackageCard key={t.id} pkg={t} />
                    ))}
                  </Grid>
                </Section>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- helpers + sub-components ---------------------------------------

function summaryOf(m: { summary?: string } | null | undefined): string {
  return typeof m?.summary === "string" ? m.summary : "";
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function RoleChip({
  label,
  active,
  onClick,
  swatchClass,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  swatchClass?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-foreground/30 bg-foreground text-background"
          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      aria-pressed={active}
    >
      {swatchClass && (
        <span
          aria-hidden
          className={cn(
            "inline-block h-2 w-2 rounded-full border",
            // Drop the text-* part for the dot — only keep border + bg.
            swatchClass.replace(/text-chart-\d+/, ""),
          )}
        />
      )}
      {label}
    </button>
  );
}

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <Card className="bg-muted/20 flex flex-col items-center justify-center gap-2 border-dashed px-6 py-10 text-center">
      <div className="bg-muted text-muted-foreground flex h-10 w-10 items-center justify-center rounded-full">
        {icon}
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-sm text-xs">{hint}</p>
    </Card>
  );
}

/**
 * The reach + trigger row every skill card carries.
 *
 * `describeSkillReach` is what makes the empty-`targets` case render as "Every
 * role" rather than as nothing at all — see the module header of
 * `lib/marketplace/skill-view.ts`. The old card rendered the chip row only
 * `targets.length > 0`, so the broadest skill in the catalog looked like the
 * narrowest one.
 */
function SkillFacts({ skill, labelFor }: { skill: SkillRow; labelFor: (slug: string) => string }) {
  const reach = describeSkillReach(skill.targets);
  const triggers = describeSkillTriggers(skill.triggers);
  const size = describeBodySize(skill.body);
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap gap-1">
        {reach.allRoles ? (
          <span className="border-warning/40 bg-warning/10 text-warning inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            <Sparkles className="h-2.5 w-2.5" aria-hidden />
            Every role
          </span>
        ) : (
          reach.roles.map((t) => (
            <span
              key={t}
              className={cn(
                "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                ROLE_COLOR[t] ?? "border-border bg-muted text-muted-foreground",
              )}
            >
              {labelFor(t)}
            </span>
          ))
        )}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
        <span className="inline-flex items-center gap-1">
          <Zap className="h-2.5 w-2.5" aria-hidden />
          {triggers.length === 0
            ? "no trigger words"
            : `${triggers.length} trigger${triggers.length === 1 ? "" : "s"}`}
        </span>
        <span className="tabular-nums">{size.chars.toLocaleString()} chars of prompt</span>
      </div>
    </div>
  );
}

function OriginBadge({ skill }: { skill: SkillRow }) {
  const origin = classifySkillOrigin(skill);
  const tone = origin === "authored" ? "violet" : origin === "installed" ? "ok" : "muted";
  return (
    <Badge tone={tone} className="shrink-0 text-[10px]">
      {origin === "authored" && <PenLine aria-hidden />}
      {originLabel(origin)}
    </Badge>
  );
}

// Pure presentational card; the install button is its own sub-component so
// the loading/optimistic state is local to it.
function SkillCard({
  skill,
  installed,
  labelFor,
}: {
  skill: SkillRow;
  installed: SkillRow | null;
  labelFor: (slug: string) => string;
}) {
  const summary = summaryOf(skill.manifest);
  const verified = !!skill.manifest?.verified;
  // `skill` is the PUBLIC row here and `installed` this workspace's clone of it,
  // so the arguments are the reverse of the installed card's. Routed through the
  // same classifier rather than left on `compareWithInstalled` so the Available
  // tab cannot report a difference the Installed tab attributes differently.
  const installedProvenance = installed ? classifySkillProvenance(installed, skill) : null;
  return (
    <Card className="group flex flex-col transition-shadow hover:shadow-md">
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <div className="bg-muted text-muted-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
          <FileCode className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CardTitle className="truncate text-sm">{skill.name}</CardTitle>
            <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
              v{skill.version}
            </span>
            {verified && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-success inline-flex shrink-0 items-center justify-center">
                    <ShieldCheck className="h-3.5 w-3.5" aria-label="Verified by DevPilot" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>Verified by DevPilot</TooltipContent>
              </Tooltip>
            )}
          </div>
          {summary && (
            <CardDescription className="mt-1 line-clamp-2 text-xs">{summary}</CardDescription>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 pb-3 pt-0">
        <SkillFacts skill={skill} labelFor={labelFor} />
        {installedProvenance && <SkillProvenanceNote provenance={installedProvenance} />}
      </CardContent>
      <CardFooter className="mt-auto justify-between gap-2 border-t pt-3">
        <ReviewButton skill={skill} installed={installed} labelFor={labelFor} />
        <InstallButton
          kind="skill"
          publicId={skill.id}
          installedId={installed?.id ?? null}
          name={skill.name}
        />
      </CardFooter>
    </Card>
  );
}

function InstalledSkillCard({
  skill,
  source,
  tenantId,
  labelFor,
}: {
  skill: SkillRow;
  /** The public row this was cloned from, when there is one. */
  source: SkillRow | null;
  tenantId: string;
  labelFor: (slug: string) => string;
}) {
  const summary = summaryOf(skill.manifest);
  const origin = classifySkillOrigin(skill);
  // Replaces a single "differs from the public vN" line that fired both when
  // the operator had deliberately edited his copy and when the catalogue had
  // moved on under it — two causes with opposite remedies, shown identically.
  const provenance = classifySkillProvenance(skill, source);
  const resetOffer = describeCatalogResetOffer(provenance);
  return (
    <Card
      className={cn(
        "flex flex-col",
        // Authored rows carry a coloured rail: this tenant wrote the prompt
        // text, nobody upstream reviewed it, and it is the one kind of row the
        // operator can change. It should not look like a verified clone.
        origin === "authored" && "border-chart-4/40 border-l-2",
      )}
    >
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
            origin === "authored" ? "bg-chart-4/10 text-chart-4" : "bg-success/10 text-success",
          )}
        >
          {origin === "authored" ? <PenLine className="h-4 w-4" /> : <Check className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="min-w-0 truncate text-sm">{skill.name}</CardTitle>
            <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
              v{skill.version}
            </span>
            <SkillProvenanceBadge provenance={provenance} />
          </div>
          {summary && (
            <CardDescription className="mt-1 line-clamp-2 text-xs">{summary}</CardDescription>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 pb-3 pt-0">
        <SkillFacts skill={skill} labelFor={labelFor} />
        <SkillProvenanceNote provenance={provenance} />
      </CardContent>
      <CardFooter className="mt-auto flex-wrap justify-between gap-2 border-t pt-3">
        <div className="flex flex-wrap items-center gap-1">
          <ReviewButton skill={skill} installed={null} labelFor={labelFor} />
          {/*
            Edit is offered only for rows this tenant owns; the component owns
            that rule so it can be proven by rendering (see
            lib/marketplace/__tests__/skill-preview-render.test.ts).
          */}
          <SkillEditLink skill={skill} tenantId={tenantId} />
          {resetOffer.offered && (
            <CatalogResetButton skillId={skill.id} name={skill.name} offer={resetOffer} />
          )}
        </div>
        <UninstallButton kind="skill" installedId={skill.id} name={skill.name} />
      </CardFooter>
    </Card>
  );
}

function ToolPackageCard({
  pkg,
  installedId,
}: {
  pkg: ToolPackageRow;
  installedId: string | null;
}) {
  const summary = summaryOf(pkg.manifest);
  const verified = !!pkg.manifest?.verified;
  const tools = Array.isArray(pkg.manifest?.tools) ? pkg.manifest!.tools! : [];
  return (
    <Card className="group flex flex-col transition-shadow hover:shadow-md">
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <div className="bg-muted text-muted-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
          <Wrench className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CardTitle className="truncate text-sm">{pkg.name}</CardTitle>
            <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
              v{pkg.version}
            </span>
            {verified && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-success inline-flex shrink-0 items-center justify-center">
                    <ShieldCheck className="h-3.5 w-3.5" aria-label="Verified by DevPilot" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>Verified by DevPilot</TooltipContent>
              </Tooltip>
            )}
          </div>
          {summary && (
            <CardDescription className="mt-1 line-clamp-2 text-xs">{summary}</CardDescription>
          )}
        </div>
      </CardHeader>
      {tools.length > 0 && (
        <CardContent className="flex-1 pb-3 pt-0">
          <div className="flex flex-wrap gap-1">
            {tools.slice(0, 4).map((t) => (
              <Badge key={t} tone="muted" className="font-mono text-[10px]">
                {t}
              </Badge>
            ))}
            {tools.length > 4 && (
              <Badge tone="muted" className="text-[10px]">
                +{tools.length - 4} more
              </Badge>
            )}
          </div>
        </CardContent>
      )}
      <CardFooter className="mt-auto justify-end border-t pt-3">
        <InstallButton
          kind="tool_package"
          publicId={pkg.id}
          installedId={installedId}
          name={pkg.name}
        />
      </CardFooter>
    </Card>
  );
}

function InstalledToolPackageCard({ pkg }: { pkg: ToolPackageRow }) {
  const summary = summaryOf(pkg.manifest);
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <div className="bg-success/10 text-success flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
          <Check className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CardTitle className="truncate text-sm">{pkg.name}</CardTitle>
            <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
              v{pkg.version}
            </span>
          </div>
          {summary && (
            <CardDescription className="mt-1 line-clamp-2 text-xs">{summary}</CardDescription>
          )}
        </div>
      </CardHeader>
      <CardFooter className="mt-auto justify-end border-t pt-3">
        <UninstallButton kind="tool_package" installedId={pkg.id} name={pkg.name} />
      </CardFooter>
    </Card>
  );
}

/**
 * Opens the review panel.
 *
 * This replaces a `<details>` that expanded a ~200px-tall body pane INSIDE a
 * one-third-width grid card. Reading 4,000 characters of prompt text through
 * that window was not review, and its `max-w-[90vw]` on an element nested in a
 * grid cell was a horizontal-overflow hazard besides. A dialog is what gives
 * the body the width and height it needs without disturbing the grid.
 */
function ReviewButton({
  skill,
  installed,
  labelFor,
}: {
  skill: SkillRow;
  installed: SkillRow | null;
  labelFor: (slug: string) => string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1.5">
        <ScanEye className="h-3.5 w-3.5" />
        Review
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/*
          `max-w-3xl` gives the body a readable measure; `overflow-x-hidden`
          plus the `min-w-0` chain inside <SkillPreview> is what keeps a long
          unbroken line scrolling in its own pane rather than widening the page.
        */}
        <DialogContent className="max-w-3xl overflow-x-hidden">
          <div className="min-w-0">
            <DialogTitle className="flex flex-wrap items-center gap-2 pr-6 text-base">
              <span className="min-w-0 break-words">{skill.name}</span>
              <span className="text-muted-foreground shrink-0 font-mono text-xs">
                v{skill.version}
              </span>
              <OriginBadge skill={skill} />
            </DialogTitle>
            <DialogDescription className="sr-only">
              Full body and dispatch behaviour for the {skill.name} skill.
            </DialogDescription>
          </div>
          <SkillPreview skill={skill} installed={installed} labelFor={labelFor} />
          {/*
            The assisted half of "review the body before installing". Below the
            preview on purpose: the body is what the operator is being asked to
            read, and a result rendered above it would be read INSTEAD.
          */}
          <div className="border-border min-w-0 border-t pt-4">
            <SkillScan skillId={skill.id} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Overwrite this workspace's copy with the catalogue's current text.
 *
 * ONE control for what read as two features. "Reset to the original" and "take
 * the update" are the same write — replace the copy from the public source —
 * and shipping them as two buttons would imply otherwise while sharing a code
 * path anyway. What genuinely differs is the LABEL and what the operator is
 * giving up, and both come from `describeCatalogResetOffer` rather than from
 * anything decided here.
 *
 * Confirmed, because it is destructive and irreversible from this screen: the
 * operator's own wording, which he may have spent real thought on, is gone. The
 * warning is rendered in the dialog body rather than as a `title` attribute for
 * the same reason the provenance note is visible text.
 */
function CatalogResetButton({
  skillId,
  name,
  offer,
}: {
  skillId: string;
  name: string;
  offer: Extract<ReturnType<typeof describeCatalogResetOffer>, { offered: true }>;
}) {
  const [pending, setPending] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  async function onReset() {
    setPending(true);
    const res = await resetSkillToCatalogAction(skillId);
    setPending(false);
    setConfirmOpen(false);
    if (!res.ok) {
      toast.error(`Could not reset ${name}`, { description: res.error });
      return;
    }
    toast.success(`${name} now matches the catalogue`, {
      description: "Agents matching this skill see the catalogue text on their next run.",
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        disabled={pending}
        className="gap-1.5"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {offer.label}
      </Button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>
            {offer.label} of {name}?
          </DialogTitle>
          <DialogDescription>{offer.warning}</DialogDescription>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={offer.discardsEdit ? "destructive" : "primary"}
              size="sm"
              onClick={onReset}
              disabled={pending}
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {pending ? "Replacing…" : offer.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InstallButton({
  kind,
  publicId,
  installedId,
  name,
}: {
  kind: Kind;
  publicId: string;
  installedId: string | null;
  name: string;
}) {
  const [pending, setPending] = React.useState(false);
  // The server action revalidates `/marketplace`, which re-renders the page
  // and flips `installedId` to a real value — we just reflect it here.
  if (installedId) {
    return (
      <Button variant="subtle" size="sm" disabled className="cursor-default gap-1.5">
        <Check className="h-3.5 w-3.5" />
        Installed
      </Button>
    );
  }
  async function onInstall() {
    setPending(true);
    const res =
      kind === "skill"
        ? await installSkillAction(publicId)
        : await installToolPackageAction(publicId);
    setPending(false);
    if (!res.ok) {
      toast.error(`Failed to install ${name}`, { description: res.error });
      return;
    }
    toast.success(`Installed ${name}`, {
      description:
        kind === "skill"
          ? "Available to the dispatcher on the next ticket."
          : "Catalog entry reserved for this tenant.",
    });
  }
  return (
    <Button
      variant="primary"
      size="sm"
      onClick={onInstall}
      disabled={pending}
      title={`Install "${name}" into this tenant`}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {pending ? "Installing…" : "Install"}
    </Button>
  );
}

function UninstallButton({
  kind,
  installedId,
  name,
}: {
  kind: Kind;
  installedId: string;
  name: string;
}) {
  const [pending, setPending] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  async function onUninstall() {
    setPending(true);
    const res =
      kind === "skill"
        ? await uninstallSkillAction(installedId)
        : await uninstallToolPackageAction(installedId);
    setPending(false);
    setConfirmOpen(false);
    if (!res.ok) {
      toast.error(`Failed to uninstall ${name}`, { description: res.error });
      return;
    }
    toast.success(`Uninstalled ${name}`);
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)} disabled={pending}>
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {pending ? "Uninstalling…" : "Uninstall"}
      </Button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Uninstall {name}?</DialogTitle>
          <DialogDescription>
            {kind === "skill"
              ? "This removes the skill from this tenant. Any role wired to use it stops seeing it in future dispatches until it's reinstalled."
              : "This removes the tool package from this tenant. Roles configured to use it lose access until it's reinstalled."}
          </DialogDescription>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onUninstall}
              disabled={pending}
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {pending ? "Uninstalling…" : "Uninstall"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Skeleton row used by the page's React Suspense boundary when listings load.
export function MarketplaceSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="flex flex-col">
          <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
            <Skeleton className="h-9 w-9 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-44" />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex gap-1">
              <Skeleton className="h-4 w-12 rounded-md" />
              <Skeleton className="h-4 w-12 rounded-md" />
            </div>
          </CardContent>
          <CardFooter className="mt-auto justify-end border-t pt-3">
            <Skeleton className="h-8 w-20 rounded-md" />
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
