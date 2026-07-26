// Project-scope chrome: the configuration overview, the rollup tiles/bars, the
// summary table for tickets beyond the detail cap, and the TOC.

import React from "react";
import { Text, View } from "@react-pdf/renderer";
import { COLORS, SURFACE, mix, roleColor, statusColor } from "@/lib/export/theme";
import { FONT_FAMILY } from "@/lib/export/fonts";
import {
  Bar,
  Empty,
  Field,
  Pill,
  RoleChip,
  StatusPill,
  styles,
} from "@/lib/export/components/primitives";
import { ticketKey } from "@/lib/export/components/TicketSection";
import {
  SPEND_CAVEAT_SHORT,
  spendCaveat,
  formatCents,
  formatDurationMs,
  formatTimestamp,
  type ExportBounding,
  type ExportProject,
  type ExportStackRow,
  type ProjectRollups,
  type TicketSummary,
} from "@/lib/export/types";

export function ProjectConfig({ project }: { project: ExportProject }) {
  return (
    <View style={styles.card}>
      <Field label="Project id" value={project.id} mono />
      <Field label="Repository" value={project.repoUrl ?? "—"} mono />
      <Field label="Default branch" value={project.defaultBranch} mono />
      <Field
        label="Integration branch"
        value={project.integrationBranch ?? "— (legacy: PRs target default)"}
        mono
      />
      <Field
        label="Auto-land"
        value={project.autoLandEnabled ? "enabled" : "disabled"}
        tone={project.autoLandEnabled ? COLORS.chart2 : COLORS.mutedForeground}
      />
      <Field
        label="Agent ticket filing"
        value={project.agentTicketCreation ? "enabled" : "disabled (default)"}
        tone={project.agentTicketCreation ? COLORS.warning : COLORS.mutedForeground}
      />
      {/* Only meaningful while filing is enabled - printing a ceiling for a
          project whose agents cannot file reads as a permission it does not
          have. NULL renders as "inherited", never as a resolved number: the
          resolved value depends on the INSTANCE's env at run time, which this
          document cannot observe and must not assert. */}
      {project.agentTicketCreation ? (
        <Field
          label="Tickets per run"
          value={
            project.agentTicketMaxPerRun === null
              ? "inherited (instance default)"
              : String(project.agentTicketMaxPerRun)
          }
        />
      ) : null}
      <Field label="Platform" value={project.projectType} />
      <Field label="Team tier" value={project.teamTier} />
      <Field label="Stack ecosystem" value={project.stackEcosystem} />
      <Field label="Created" value={formatTimestamp(project.createdAt)} />
      <View style={styles.rule} />
      {/* REDACTED BY CONSTRUCTION: `llm_credential_ref` is never selected from
          the DB, and `llm_base_url` never leaves the aggregator — only the fact
          that a custom endpoint exists does. See `ExportLlmConfig`. */}
      <Text style={{ ...styles.eyebrow, marginBottom: 3 }}>Model routing</Text>
      <Field
        label="Provider"
        value={project.llm.provider ?? "inherited (tenant » instance » env)"}
      />
      <Field label="Model" value={project.llm.model ?? "tier default"} mono />
      <Field
        label="Endpoint"
        value={
          project.llm.customEndpoint
            ? "custom endpoint configured (URL withheld)"
            : "provider default"
        }
      />
      <Text style={{ ...styles.muted, fontSize: 6.5, marginTop: 4 }}>
        Credentials and any custom endpoint URL are deliberately excluded from this export.
      </Text>
    </View>
  );
}

export function StackTable({ stack }: { stack: ExportStackRow[] }) {
  if (stack.length === 0) return <Empty>No stack selection recorded for this project.</Empty>;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: COLORS.border,
        borderStyle: "solid",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <View style={{ flexDirection: "row", backgroundColor: COLORS.muted }}>
        {["Capability", "Service", "Provider", "Free tier"].map((h, i) => (
          <View key={h} style={{ flex: i === 0 ? 1.2 : 1, padding: 4 }}>
            <Text style={{ fontSize: 7.5, fontWeight: 600 }}>{h}</Text>
          </View>
        ))}
      </View>
      {stack.map((s) => (
        <View
          key={`${s.capability}-${s.service}`}
          style={{
            flexDirection: "row",
            borderTopWidth: 1,
            borderTopColor: COLORS.border,
            borderTopStyle: "solid",
          }}
        >
          <View style={{ flex: 1.2, padding: 4 }}>
            <Text style={{ fontSize: 7.5 }}>{s.capability}</Text>
          </View>
          <View style={{ flex: 1, padding: 4, flexDirection: "row", alignItems: "center", gap: 3 }}>
            <Text style={{ fontSize: 7.5 }}>{s.service}</Text>
            {s.overridden ? <Pill label="override" tone={COLORS.chart4} /> : null}
          </View>
          <View style={{ flex: 1, padding: 4 }}>
            <Text style={{ fontSize: 7.5, color: COLORS.mutedForeground }}>{s.provider}</Text>
          </View>
          <View style={{ flex: 1, padding: 4 }}>
            <Text style={{ fontSize: 7.5, color: COLORS.mutedForeground }}>
              {s.freeTier.replace(/_/g, " ")}
            </Text>
            {s.freeTierNote ? (
              <Text style={{ fontSize: 6.5, color: COLORS.mutedForeground }}>{s.freeTierNote}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function Tile({
  label,
  value,
  tone,
  caveat,
}: {
  label: string;
  value: string;
  tone?: string;
  /** Rendered under the number, in the tile's tone. For "this figure is not what
   *  it looks like" — never for decoration. */
  caveat?: string | null;
}) {
  return (
    <View
      style={{
        ...styles.card,
        flex: 1,
        paddingVertical: 8,
        backgroundColor: tone ? mix(tone, SURFACE, 0.07) : SURFACE,
        borderColor: tone ? mix(tone, COLORS.border, 0.4) : COLORS.border,
      }}
      wrap={false}
    >
      <Text style={styles.eyebrow}>{label}</Text>
      <Text
        style={{
          fontFamily: FONT_FAMILY.display,
          fontWeight: 700,
          fontSize: 15,
          color: tone ?? COLORS.foreground,
        }}
      >
        {value}
      </Text>
      {caveat ? (
        <Text style={{ fontSize: 6.5, fontWeight: 600, color: tone ?? COLORS.mutedForeground }}>
          {caveat}
        </Text>
      ) : null}
    </View>
  );
}

export function Rollups({ rollups }: { rollups: ProjectRollups }) {
  const caveat = spendCaveat(rollups);
  const maxRoleCents = Math.max(1, ...rollups.byRole.map((r) => r.totalCents));
  const statusTiles: Array<[string, number, string]> = [
    ["Done", rollups.ticketsDone, statusColor("done")],
    ["In flight", rollups.ticketsInFlight, statusColor("in_progress")],
    ["Failed", rollups.ticketsFailed, statusColor("failed")],
  ];
  return (
    <View>
      <View style={{ flexDirection: "row", gap: 6, marginBottom: 6 }}>
        {/* WI-12 — the biggest number on the page, and the one most able to
            mislead. `costPriced: false` means "we cannot price this", NOT "free":
            a project whose runs went to a self-hosted / OpenAI-compatible
            endpoint has `spent_cents = 0`, so a bare $0.00 here would read as a
            bargain. Carries the same caveat the ticket scope already shows. */}
        <Tile
          label="Total spend"
          value={formatCents(rollups.totalSpendCents)}
          tone={rollups.costPriced ? COLORS.primary : COLORS.warning}
          caveat={rollups.costPriced ? null : SPEND_CAVEAT_SHORT}
        />
        <Tile label="Runs" value={String(rollups.totalRuns)} />
        <Tile label="Tickets" value={String(rollups.totalTickets)} />
        <Tile
          label="Retries"
          value={String(rollups.totalRetries)}
          tone={rollups.totalRetries > 0 ? COLORS.warning : undefined}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 6, marginBottom: 10 }}>
        {statusTiles.map(([label, value, tone]) => (
          <Tile key={label} label={label} value={String(value)} tone={tone} />
        ))}
        <Tile label="Agent time" value={formatDurationMs(rollups.totalRunTimeMs)} />
      </View>

      <View style={{ ...styles.card, marginBottom: 10 }}>
        <Field label="Mean convergence" value={formatDurationMs(rollups.avgTicketConvergenceMs)} />
        <Field label="Last activity" value={formatTimestamp(rollups.lastActivityAt)} />
      </View>

      {caveat ? (
        <View
          style={{
            borderLeftWidth: 2,
            borderLeftColor: COLORS.warning,
            borderLeftStyle: "solid",
            backgroundColor: mix(COLORS.warning, SURFACE, 0.06),
            padding: 7,
            borderRadius: 3,
            marginBottom: 10,
          }}
        >
          <Text style={{ fontSize: 8, color: COLORS.foreground, lineHeight: 1.5 }}>
            {`${caveat} Per-role spend and the per-ticket rows carry the same gap.`}
          </Text>
        </View>
      ) : null}

      <Text style={{ ...styles.eyebrow, marginBottom: 4 }}>Spend by role</Text>
      {rollups.byRole.length === 0 ? (
        <Empty>No runs recorded.</Empty>
      ) : (
        <View style={styles.card}>
          {rollups.byRole
            .slice()
            .sort((a, b) => b.totalCents - a.totalCents)
            .map((r) => (
              <View
                key={r.role}
                style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}
                wrap={false}
              >
                {/* `alignItems: flex-start` so the chip hugs its label — a
                    flex child stretches to fill the cross axis by default, which
                    turned every chip into a full-width bar. */}
                <View style={{ width: 110, alignItems: "flex-start" }}>
                  <RoleChip role={r.role} />
                </View>
                <Bar value={r.totalCents} max={maxRoleCents} tone={roleColor(r.role)} width={110} />
                <Text style={{ ...styles.mono, width: 46, textAlign: "right" }}>
                  {formatCents(r.totalCents)}
                </Text>
                <Text style={{ ...styles.muted, fontSize: 7, flex: 1 }}>
                  {`${r.runs} run(s) · ${r.doneRuns} done · ${r.failedRuns} failed · avg ${formatDurationMs(r.avgDurationMs)}`}
                </Text>
              </View>
            ))}
        </View>
      )}
    </View>
  );
}

/**
 * Tickets beyond the full-detail cap, one line each.
 *
 * These are NOT hidden — a bounded artifact that silently drops rows reads as a
 * complete record. Every ticket appears; only the depth differs, and the
 * bounding note above says exactly where the line was drawn.
 */
export function SummaryTable({ summaries }: { summaries: TicketSummary[] }) {
  if (summaries.length === 0) return null;
  const anyUnpriced = summaries.some((s) => !s.costPriced);
  return (
    <View>
      <View
        style={{
          borderWidth: 1,
          borderColor: COLORS.border,
          borderStyle: "solid",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <View style={{ flexDirection: "row", backgroundColor: COLORS.muted }} fixed>
          {[
            ["Ticket", 1],
            ["Title", 3],
            ["Status", 1],
            ["Role", 1],
            ["Spend", 0.7],
            ["Runs", 0.5],
          ].map(([h, flex]) => (
            <View key={h as string} style={{ flex: flex as number, padding: 4 }}>
              <Text style={{ fontSize: 7.5, fontWeight: 600 }}>{h as string}</Text>
            </View>
          ))}
        </View>
        {summaries.map((s) => (
          <View
            key={s.id}
            style={{
              flexDirection: "row",
              borderTopWidth: 1,
              borderTopColor: COLORS.border,
              borderTopStyle: "solid",
              alignItems: "center",
            }}
            wrap={false}
          >
            <View style={{ flex: 1, padding: 4 }}>
              <Text style={{ ...styles.mono, fontSize: 7 }}>{ticketKey(s.ticketNumber, s.id)}</Text>
            </View>
            <View style={{ flex: 3, padding: 4 }}>
              <Text style={{ fontSize: 7.5 }}>{s.title.value}</Text>
            </View>
            {/* `alignItems: flex-start` — see the Rollups note: a pill in a flex
              cell stretches to the full column width without it. */}
            <View style={{ flex: 1, padding: 4, alignItems: "flex-start" }}>
              <StatusPill status={s.status} />
            </View>
            <View style={{ flex: 1, padding: 4, alignItems: "flex-start" }}>
              <RoleChip role={s.role} />
            </View>
            <View style={{ flex: 0.7, padding: 4 }}>
              {/* An asterisked, amber figure rather than a bare one: this ticket
                has unpriced turns, so its spend is a lower bound. */}
              <Text
                style={{
                  ...styles.mono,
                  fontSize: 7,
                  color: s.costPriced ? COLORS.foreground : COLORS.warning,
                }}
              >
                {s.costPriced ? formatCents(s.totalCents) : `${formatCents(s.totalCents)}*`}
              </Text>
            </View>
            <View style={{ flex: 0.5, padding: 4 }}>
              <Text style={{ ...styles.mono, fontSize: 7 }}>{s.runs}</Text>
            </View>
          </View>
        ))}
      </View>
      {/* A bare asterisk in a spend column is noise without this. */}
      {anyUnpriced ? (
        <Text style={{ ...styles.muted, fontSize: 6.5, marginTop: 4, color: COLORS.warning }}>
          * Spend is a lower bound — this ticket has model turns that ran on a provider with no
          price table, whose cost is not included.
        </Text>
      ) : null}
    </View>
  );
}

/** The bounding disclosure. Printed whenever detail was capped. */
export function BoundingNote({ bounding }: { bounding: ExportBounding }) {
  if (!bounding.truncated) return null;
  return (
    <View
      style={{
        borderLeftWidth: 2,
        borderLeftColor: COLORS.warning,
        borderLeftStyle: "solid",
        backgroundColor: mix(COLORS.warning, SURFACE, 0.06),
        padding: 7,
        borderRadius: 3,
        marginBottom: 10,
      }}
    >
      <Text style={{ fontSize: 8, color: COLORS.foreground, lineHeight: 1.5 }}>
        {`This project has ${bounding.totalTickets} tickets. Full per-ticket detail — narration, cost and ` +
          `evidence — is included for ${bounding.fullCount} of them (the export cap is ${bounding.cap}). ` +
          `The remaining ${bounding.summaryCount} are listed in the summary table with their status, role ` +
          "and spend. For the full audit trail of any one of them, use the per-ticket PDF export from that " +
          "ticket's drawer."}
      </Text>
    </View>
  );
}

/**
 * Contents. react-pdf resolves page numbers at layout time, but only through the
 * `render` callback on an already-placed element — a TOC needs each entry's
 * FINAL page, which is not known while the TOC itself is being laid out. Rather
 * than a two-pass render (render once, read the page map, re-render), this
 * lists sections in order without page numbers and leans on the PDF OUTLINE for
 * navigation, which every viewer exposes as a clickable sidebar and which is
 * exact rather than approximate. Page-numbered entries are the enhancement that
 * a second pass would buy.
 */
export function Toc({ entries }: { entries: string[] }) {
  return (
    <View style={styles.card}>
      {entries.map((e, i) => (
        <View
          key={`${i}-${e}`}
          style={{ flexDirection: "row", alignItems: "center", marginBottom: 3 }}
        >
          <Text style={{ ...styles.mono, fontSize: 7, color: COLORS.mutedForeground, width: 18 }}>
            {String(i + 1).padStart(2, "0")}
          </Text>
          <Text style={{ fontSize: 8.5, color: COLORS.foreground, flex: 1 }}>{e}</Text>
        </View>
      ))}
      <Text style={{ ...styles.muted, fontSize: 6.5, marginTop: 5 }}>
        Use your PDF viewer&apos;s bookmarks/outline panel to jump to any section or ticket.
      </Text>
    </View>
  );
}
