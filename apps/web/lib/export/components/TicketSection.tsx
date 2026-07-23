// One ticket, rendered in full: identity, the human/agent narrative, the
// dependency graph around it, its evidence, and every run's narration + cost.
//
// This is the audit substance. The ordering is the argument the document makes:
// WHAT was asked (ticket) → WHAT was said about it (thread) → WHAT it depended
// on (relations) → WHAT was attached (evidence images) → WHAT the agents
// actually did, cost, and proved (runs). A reader who stops after any one
// section has still read something true.

import React from "react";
import { Link, Text, View } from "@react-pdf/renderer";
import { COLORS, SURFACE, mix, roleColor } from "@/lib/export/theme";
import { FONT_FAMILY } from "@/lib/export/fonts";
import { markdownToBlocks } from "@/lib/export/markdown";
import { Markdown } from "@/lib/export/components/Markdown";
import { EmbeddedImage } from "@/lib/export/components/EmbeddedImage";
import {
  BookmarkView,
  Empty,
  Field,
  Pill,
  RoleChip,
  RunStatusPill,
  StatusPill,
  TrustRail,
  styles,
} from "@/lib/export/components/primitives";
import {
  SPEND_CAVEAT_SHORT,
  spendCaveat,
  classifyVerification,
  formatCents,
  formatTimestamp,
  formatTokens,
  type VerificationOutcome,
  type ExportRelationRef,
  type ExportRelations,
  type RunAudit,
  type TicketAuditExport,
  type Untrusted,
} from "@/lib/export/types";
import { oneLineTruncated } from "@/lib/export/truncate";

/** `DevPilot-42`, or the short-hex fallback for a ticket with no project counter. */
export function ticketKey(ticketNumber: number | null, id: string): string {
  if (ticketNumber !== null && Number.isFinite(ticketNumber)) return `DevPilot-${ticketNumber}`;
  return `DevPilot-${id.replace(/-/g, "").slice(0, 8)}`;
}

/**
 * A title flattened for a PDF outline entry.
 *
 * Ticket titles are often agent-authored and may contain newlines; a bookmark
 * label is a single-line affordance in every viewer's sidebar, so an embedded
 * newline either renders as a control character or breaks the entry. The full
 * title is still drawn verbatim in the section heading right below it.
 *
 * Truncation is by CODE POINT (`oneLineTruncated`), not by `slice` — those same
 * agent-authored titles routinely carry emoji, and a code-unit slice lands
 * mid-surrogate-pair whenever one straddles the limit.
 */
export function bookmarkLabel(s: string, max = 90): string {
  return oneLineTruncated(s, max);
}

/** Untrusted markdown: attributed rail + AST-allowlisted rendering. */
function UntrustedMarkdown({ value, note }: { value: Untrusted; note?: string }) {
  return (
    <TrustRail trust={value.trust} note={note}>
      <Markdown blocks={markdownToBlocks(value.value)} />
    </TrustRail>
  );
}

function RefLine({ refs, tone }: { refs: ExportRelationRef[]; tone?: string }) {
  return (
    <>
      {refs.map((r) => (
        <View
          key={r.id}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 }}
        >
          <Text style={{ ...styles.mono, color: tone ?? COLORS.mutedForeground, width: 74 }}>
            {ticketKey(r.ticketNumber, r.id)}
          </Text>
          <Text style={{ fontSize: 8, flex: 1, color: COLORS.foreground }}>{r.title.value}</Text>
          <StatusPill status={r.status} />
          {/* WI-5 — a `done` blocker whose commits are not on the integration
              branch yet is NOT resolved, and must never print as if it were. */}
          {r.landOpenness === "awaiting_land" ? (
            <Pill label="awaiting land" tone={COLORS.warning} />
          ) : null}
          {r.landOpenness === "working" ? <Pill label="open" tone={COLORS.warning} /> : null}
        </View>
      ))}
    </>
  );
}

function RelationGroup({
  label,
  refs,
  tone,
}: {
  label: string;
  refs: ExportRelationRef[];
  tone?: string;
}) {
  if (refs.length === 0) return null;
  return (
    <View style={{ marginBottom: 5 }}>
      <Text style={{ ...styles.eyebrow, marginBottom: 2 }}>{label}</Text>
      <RefLine refs={refs} tone={tone} />
    </View>
  );
}

function Relations({ relations }: { relations: ExportRelations }) {
  const total =
    relations.blockedBy.length +
    relations.blocks.length +
    relations.buildsOn.length +
    relations.builtOnBy.length +
    relations.related.length +
    relations.duplicate.length +
    relations.subIssues.length;
  if (total === 0) return <Empty>No relations.</Empty>;
  return (
    <View>
      <RelationGroup label="Blocked by" refs={relations.blockedBy} tone={COLORS.destructive} />
      <RelationGroup label="Builds on" refs={relations.buildsOn} tone={COLORS.chart4} />
      <RelationGroup label="Blocks" refs={relations.blocks} />
      <RelationGroup label="Built on by" refs={relations.builtOnBy} />
      <RelationGroup label="Sub-issues" refs={relations.subIssues} />
      {/* `related`/`duplicate` never gate readiness — grouped apart so the
          document does not imply they do. */}
      <RelationGroup label="Related (non-blocking)" refs={relations.related} />
      <RelationGroup label="Duplicate (non-blocking)" refs={relations.duplicate} />
    </View>
  );
}

/**
 * QA-gate evidence. A failing exit code is rendered loudly, never as a footnote —
 * and an INDETERMINATE one is never rendered as a pass.
 *
 * The three states come from `classifyVerification`, which mirrors the live gate.
 * Green is reserved for `exit 0` alone; a killed/timed-out/unrunnable check
 * (`exit < 0`, which producers write as `code ?? -1`) gets its own amber
 * "did not run" state that says so in words. See `VerificationOutcome`.
 */
const VERIFICATION_PRESENTATION: Record<
  VerificationOutcome,
  { label: string; tone: string; note: string | null }
> = {
  passed: { label: "verification passed", tone: COLORS.chart2, note: null },
  failed: { label: "verification failed", tone: COLORS.destructive, note: null },
  indeterminate: {
    label: "verification did not run",
    tone: COLORS.warning,
    note:
      "The check could not be completed (it was killed, timed out, or failed to start), so this " +
      "run is NOT evidence that the command passed. The hand-off gate lets a ticket through in " +
      "this state by design — an unrunnable check must not strand work — but nothing here was " +
      "verified.",
  },
};

function Verification({ run }: { run: RunAudit }) {
  const v = run.verification;
  if (!v) return null;
  const outcome = classifyVerification(v.exitCode);
  const { label, tone, note } = VERIFICATION_PRESENTATION[outcome];
  return (
    <View
      style={{
        marginTop: 6,
        borderWidth: 1,
        borderColor: tone,
        borderStyle: "solid",
        borderRadius: 4,
        backgroundColor: mix(tone, SURFACE, 0.06),
        padding: 7,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 4 }}>
        <Pill label={label} tone={tone} />
        <Text style={{ ...styles.muted }}>exit {v.exitCode}</Text>
        {v.pushed ? <Pill label="pushed" tone={COLORS.mutedForeground} /> : null}
      </View>
      {note ? <Text style={{ ...styles.muted, color: tone, marginBottom: 4 }}>{note}</Text> : null}
      <Field label="Command" value={v.command.value} mono />
      <Field label="Head sha" value={v.headSha.slice(0, 12)} mono />
      <Field label="Base sha" value={v.baseSha ? v.baseSha.slice(0, 12) : "—"} mono />
      {v.outputTail.value.trim().length > 0 ? (
        <View style={{ marginTop: 4 }}>
          <TrustRail trust={v.outputTail.trust} note="command output">
            <Text style={{ fontFamily: FONT_FAMILY.mono, fontSize: 7, color: COLORS.foreground }}>
              {v.outputTail.value}
            </Text>
          </TrustRail>
        </View>
      ) : null}
    </View>
  );
}

function Turn({ turn }: { turn: RunAudit["turns"][number] }) {
  return (
    <View style={{ marginBottom: 8 }} wrap>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 3 }}>
        <Text style={{ ...styles.eyebrow }}>Turn {turn.idx}</Text>
        <Text style={{ ...styles.muted, fontSize: 7 }}>{turn.model ?? "—"}</Text>
        <Text style={{ ...styles.muted, fontSize: 7 }}>
          {formatTokens((turn.usage.promptTokens ?? 0) + (turn.usage.completionTokens ?? 0))} tok
        </Text>
        {/* WI-12 — an unpriced turn is labelled, not silently shown as $0.00.
            A self-hosted endpoint we have no price table for is not free. */}
        {turn.costPriced ? (
          <Text style={{ ...styles.muted, fontSize: 7 }}>{formatCents(turn.costCents)}</Text>
        ) : (
          <Pill label="unpriced" tone={COLORS.warning} />
        )}
      </View>
      {turn.text.value.trim().length > 0 ? (
        <UntrustedMarkdown value={turn.text} note="model narration" />
      ) : (
        <Empty>No narration recorded for this turn.</Empty>
      )}
    </View>
  );
}

function Run({ run, index }: { run: RunAudit; index: number }) {
  const tone = roleColor(run.role);
  return (
    <View style={{ marginBottom: 12 }}>
      {/* This card can break across a page boundary when a run's narration is
          long. That is safe: the out-of-range-coordinate crash the export used to
          take on page-spanning content was NOT this box's border geometry — it was
          the `bottom`-anchored running footer diverging on deep continuation pages
          (see `Chrome.Footer`), which corrupted the page's own coordinate frame and
          made every box splitting on that page — including this one — pick up the
          garbage. With the footer top-anchored, this card renders cleanly across a
          split; `split-run-card.test.ts` asserts a page-spanning run emits no
          out-of-range coordinate. */}
      <View
        style={{
          ...styles.card,
          borderLeftWidth: 3,
          borderLeftColor: tone,
          borderLeftStyle: "solid",
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 5 }}
          wrap={false}
        >
          <Text style={{ ...styles.h3, marginBottom: 0 }}>Run {index + 1}</Text>
          <RoleChip role={run.role} />
          <RunStatusPill status={run.status} />
          {run.replayOfRunId ? <Pill label="replay" tone={COLORS.chart4} /> : null}
          {run.fanOutRole ? (
            <Pill label={`fan-out: ${run.fanOutRole}`} tone={COLORS.chart1} />
          ) : null}
        </View>

        <Field label="Run id" value={run.id} mono />
        {run.agentName ? <Field label="Agent" value={run.agentName} /> : null}
        <Field label="Runner" value={run.runnerKind ?? "—"} />
        <Field label="Started" value={formatTimestamp(run.createdAt)} />
        <Field label="Last event" value={formatTimestamp(run.lastEventAt)} />
        <Field
          label="Spend"
          value={`${formatCents(run.spentCents)} of ${formatCents(run.budgetCents)} budget`}
        />
        {run.statusReason ? <Field label="Status reason" value={run.statusReason} mono /> : null}
        {/* The escape hatch to the full tool-by-tool trace, which this artifact
            deliberately does not inline. */}
        {run.langfuseTraceUrl ? (
          <View style={{ flexDirection: "row", marginBottom: 2.5 }}>
            <Text style={{ ...styles.muted, width: 96, flexShrink: 0 }}>Full trace</Text>
            <Link
              src={run.langfuseTraceUrl}
              style={{ fontSize: 8, color: COLORS.primary, textDecoration: "none", flex: 1 }}
            >
              View every tool call in Langfuse
            </Link>
          </View>
        ) : null}

        <Verification run={run} />

        <View style={styles.rule} />
        <Text style={{ ...styles.eyebrow, marginBottom: 5 }}>Agent narration</Text>
        {run.turns.length === 0 ? (
          <Empty>This run recorded no model turns.</Empty>
        ) : (
          run.turns.map((t) => <Turn key={t.idx} turn={t} />)
        )}

        {run.toolUses.length > 0 ? (
          <View style={{ marginTop: 4 }}>
            <Text style={{ ...styles.eyebrow, marginBottom: 3 }}>
              Human takeover — tool activity
            </Text>
            {run.toolUses.map((t) => (
              <Text
                key={t.idx}
                style={{ fontFamily: FONT_FAMILY.mono, fontSize: 7, color: COLORS.mutedForeground }}
              >
                {`→ ${t.summary.value}`}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function CostSummary({ data }: { data: TicketAuditExport }) {
  const { cost } = data;
  return (
    <View style={{ ...styles.card, marginBottom: 10 }} wrap={false}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <View>
          <Text style={styles.eyebrow}>Total spend</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Text style={{ fontFamily: FONT_FAMILY.display, fontWeight: 700, fontSize: 18 }}>
              {formatCents(cost.totalCents)}
            </Text>
            {/* The pricing-confidence flag. `costPriced: false` means "we cannot
                price this", NOT "free" — printing a bare $0.00 would be a lie of
                omission on a document someone signs off against. */}
            {cost.costPriced ? null : <Pill label={SPEND_CAVEAT_SHORT} tone={COLORS.warning} />}
          </View>
        </View>
        <View>
          <Text style={styles.eyebrow}>Runs</Text>
          <Text style={{ fontFamily: FONT_FAMILY.display, fontWeight: 700, fontSize: 18 }}>
            {cost.runCount}
          </Text>
        </View>
        <View>
          <Text style={styles.eyebrow}>Prompt tokens</Text>
          <Text style={{ fontFamily: FONT_FAMILY.mono, fontSize: 12 }}>
            {formatTokens(cost.promptTokens)}
          </Text>
        </View>
        <View>
          <Text style={styles.eyebrow}>Completion tokens</Text>
          <Text style={{ fontFamily: FONT_FAMILY.mono, fontSize: 12 }}>
            {formatTokens(cost.completionTokens)}
          </Text>
        </View>
      </View>
      {/* Same pure `spendCaveat` the project scope uses, so the two cannot drift
          into describing the same situation differently. */}
      {spendCaveat(cost) ? (
        <Text style={{ ...styles.muted, marginTop: 5, color: COLORS.warning }}>
          {`${spendCaveat(cost)} Token usage above is still counted.`}
        </Text>
      ) : null}
    </View>
  );
}

function Attachments({ data }: { data: TicketAuditExport }) {
  if (data.attachments.length === 0) return null;
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ ...styles.eyebrow, marginBottom: 4 }}>Attached evidence</Text>
      {data.attachments.map((a) => (
        <View key={a.id} style={{ marginBottom: 8 }} wrap={false}>
          {/* Shared with the guide manual's figures — one placeholder contract,
              not two that drift. See `EmbeddedImage`. */}
          <EmbeddedImage
            dataUri={a.dataUri}
            unavailableReason={a.unavailableReason}
            imageStyle={{ maxHeight: 260 }}
          />
          <Text style={{ ...styles.muted, fontSize: 6.5, marginTop: 2 }}>
            {`${a.mime} · ${(a.bytes / 1024).toFixed(0)} KiB · attachment ${a.id.slice(0, 8)}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Thread({ data }: { data: TicketAuditExport }) {
  if (data.thread.length === 0) return <Empty>No comments or handoffs.</Empty>;
  return (
    <View>
      {data.thread.map((entry) => {
        const isHandoff = entry.kind === "handoff";
        const author = isHandoff
          ? `${entry.role} · handoff:${entry.handoffKind}`
          : `${entry.authorType}:${entry.authorId}`;
        const tone = isHandoff ? roleColor(entry.role) : COLORS.mutedForeground;
        return (
          <View key={`${entry.kind}-${entry.id}`} style={{ marginBottom: 8 }}>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 2 }}
              wrap={false}
            >
              <View style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: tone }} />
              <Text style={{ ...styles.mono, fontSize: 7, color: tone }}>{author}</Text>
              <Text style={{ ...styles.muted, fontSize: 6.5 }}>
                {formatTimestamp(entry.createdAt)}
              </Text>
            </View>
            <UntrustedMarkdown value={entry.body} />
          </View>
        );
      })}
    </View>
  );
}

function Identity({ data }: { data: TicketAuditExport }) {
  const t = data.ticket;
  return (
    <View style={{ ...styles.card, marginBottom: 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        <StatusPill status={t.status} />
        {t.requestedRole ? <RoleChip role={t.requestedRole} /> : null}
        {t.safetyCritical ? <Pill label="safety-critical" tone={COLORS.destructive} /> : null}
        {t.planHold ? <Pill label="plan hold" tone={COLORS.warning} /> : null}
        {t.retryCount > 0 ? (
          <Pill label={`retries: ${t.retryCount}`} tone={COLORS.warning} />
        ) : null}
        {t.sourceRunId ? <Pill label="filed by an agent" tone={COLORS.chart4} /> : null}
        {t.labels.map((l) => (
          <Pill key={l.name} label={l.name} tone={COLORS.mutedForeground} />
        ))}
      </View>
      <Field label="Ticket" value={ticketKey(t.ticketNumber, t.id)} mono />
      <Field label="Id" value={t.id} mono />
      <Field label="Created" value={formatTimestamp(t.createdAt)} />
      <Field label="Updated" value={formatTimestamp(t.updatedAt)} />
      <Field label="Priority" value={String(t.priority)} />
      <Field label="Branch" value={t.gitBranchName ?? "—"} mono />
      {/* WI-5 — `landed` and `done` are different facts. Print both. */}
      <Field
        label="Landed sha"
        value={t.landedSha ? t.landedSha.slice(0, 12) : "not landed"}
        mono
        tone={t.landedSha ? COLORS.foreground : COLORS.mutedForeground}
      />
      <Field label="Integrated" value={formatTimestamp(t.integratedAt)} />
      {t.sourceRunId ? <Field label="Filed by run" value={t.sourceRunId} mono /> : null}
      {t.planSessionId ? <Field label="Plan session" value={t.planSessionId} mono /> : null}
    </View>
  );
}

/**
 * `bookmarkParent` threads the project document's outline: a ticket section
 * nests under the "Ticket detail" bookmark rather than sitting at the top
 * level. `bookmarkRef` is this section's own registry id — required, and unique
 * per ticket, or sibling sections overwrite each other's registry slot (see
 * `PdfBookmark`).
 */
export function TicketSection({
  data,
  bookmarkRef,
  bookmarkParent,
  standalone = false,
}: {
  data: TicketAuditExport;
  bookmarkRef: number;
  bookmarkParent?: number;
  standalone?: boolean;
}) {
  const t = data.ticket;
  const heading = `${ticketKey(t.ticketNumber, t.id)} — ${t.title.value}`;
  return (
    <View>
      <BookmarkView
        bookmark={{ title: bookmarkLabel(heading), ref: bookmarkRef, parent: bookmarkParent }}
        style={{ marginBottom: 8 }}
      >
        {standalone ? null : (
          <>
            <Text style={styles.eyebrow}>Ticket</Text>
            <Text style={{ ...styles.h2, fontSize: 14 }}>{heading}</Text>
            <View
              style={{ height: 2, width: 28, backgroundColor: COLORS.primary, borderRadius: 1 }}
            />
          </>
        )}
      </BookmarkView>

      <Identity data={data} />
      <CostSummary data={data} />

      {t.description ? (
        <View style={{ marginBottom: 10 }}>
          <Text style={{ ...styles.eyebrow, marginBottom: 3 }}>Description</Text>
          <UntrustedMarkdown
            value={t.description}
            note={t.sourceRunId ? "agent-filed ticket" : undefined}
          />
        </View>
      ) : null}

      {t.acceptanceCriteria ? (
        <View style={{ marginBottom: 10 }}>
          <Text style={{ ...styles.eyebrow, marginBottom: 3 }}>Acceptance criteria</Text>
          <UntrustedMarkdown value={t.acceptanceCriteria} />
        </View>
      ) : null}

      <View style={{ marginBottom: 10 }}>
        <Text style={{ ...styles.eyebrow, marginBottom: 3 }}>Relations</Text>
        <Relations relations={data.relations} />
      </View>

      <Attachments data={data} />

      <View style={{ marginBottom: 10 }}>
        <Text style={{ ...styles.eyebrow, marginBottom: 3 }}>Thread</Text>
        <Thread data={data} />
      </View>

      <View>
        <Text style={{ ...styles.eyebrow, marginBottom: 4 }}>
          {`Runs (${data.runs.length}) — narration, cost, evidence`}
        </Text>
        {data.runs.length === 0 ? (
          <Empty>No runs have been dispatched for this ticket.</Empty>
        ) : (
          data.runs.map((r, i) => <Run key={r.id} run={r} index={i} />)
        )}
      </View>
    </View>
  );
}
