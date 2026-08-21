// The per-project audit document.
//
// Structure: cover → contents → configuration + stack → rollups → the bounding
// disclosure + summary table → one page per fully-detailed ticket.
//
// Bookmark hierarchy: each top-level section is an outline entry, and every
// ticket nests UNDER the "Ticket detail" entry, which is why each ticket section
// is given `bookmarkParent`. In a 100-page export the outline is the only
// workable navigation, so it is built deliberately rather than left to fall out
// of the heading order.
//
// The ids come from `BOOKMARK_REF` and are OPAQUE — deliberately not positions.
// They used to be positional indices into react-pdf's own numbering, which is
// breadth-first and shifts when the conditional summary page appears; that put
// every ticket under "Configuration & stack" on any project under the detail
// cap. See the `PdfBookmark` doc comment for the full account.

import React from "react";
import { Document, Text, View } from "@react-pdf/renderer";
import { BookmarkPage, styles } from "@/lib/export/components/primitives";
import { Cover, Footer, RunningHeader, TRUST_NOTICE } from "@/lib/export/components/Chrome";
import { Section } from "@/lib/export/components/primitives";
import { TicketSection } from "@/lib/export/components/TicketSection";
import {
  BoundingNote,
  ProjectConfig,
  Rollups,
  StackTable,
  SummaryTable,
  Toc,
} from "@/lib/export/components/ProjectOverview";
import { formatCents, formatTimestamp, type ProjectAuditExport } from "@/lib/export/types";
import { BOOKMARK_REF, ticketBookmarkRef } from "@/lib/export/bookmarks";

export function ProjectDocument({ data }: { data: ProjectAuditExport }) {
  const p = data.project;
  const title = `${p.name} — project audit`;
  const footer = `${p.name} · project audit export`;

  const tocEntries = [
    "Configuration & stack",
    "Rollups — spend, throughput, roles",
    ...(data.bounding.truncated ? ["Ticket summary (beyond the detail cap)"] : []),
    `Ticket detail (${data.tickets.length})`,
  ];

  return (
    <Document
      title={title}
      author="DevPilot"
      subject="Project audit export"
      creator="DevPilot"
      producer="DevPilot"
    >
      <BookmarkPage
        size="A4"
        style={styles.page}
        bookmark={{ title: "Cover", ref: BOOKMARK_REF.cover }}
      >
        <Footer label={footer} />
        <Cover
          eyebrow="Project audit export"
          title={p.name}
          subtitle={p.description ?? undefined}
          notice={TRUST_NOTICE}
          meta={[
            { label: "Tickets", value: String(data.bounding.totalTickets) },
            { label: "Runs", value: String(data.rollups.totalRuns) },
            {
              label: "Total spend",
              value: formatCents(data.rollups.totalSpendCents),
            },
            { label: "Repository", value: p.repoUrl ?? "—" },
            { label: "Last activity", value: formatTimestamp(data.rollups.lastActivityAt) },
            { label: "Generated", value: formatTimestamp(data.generatedAt) },
          ]}
        />
      </BookmarkPage>

      <BookmarkPage
        size="A4"
        style={styles.page}
        bookmark={{ title: "Contents", ref: BOOKMARK_REF.contents }}
      >
        <RunningHeader title={title} />
        <Footer label={footer} />
        <Section title="Contents" eyebrow="This document">
          <Toc entries={tocEntries} />
        </Section>

        <Section
          title="Configuration"
          eyebrow="Project"
          bookmark={{ title: "Configuration & stack", ref: BOOKMARK_REF.config }}
        >
          <ProjectConfig project={p} />
        </Section>

        <Section title="Committed stack" eyebrow="Capabilities">
          <StackTable stack={data.stack} />
        </Section>
      </BookmarkPage>

      <BookmarkPage
        size="A4"
        style={styles.page}
        bookmark={{ title: "Rollups", ref: BOOKMARK_REF.rollups }}
      >
        <RunningHeader title={title} />
        <Footer label={footer} />
        <Section title="Rollups" eyebrow="Spend · throughput · roles">
          <Rollups rollups={data.rollups} />
        </Section>
      </BookmarkPage>

      {data.bounding.truncated ? (
        <BookmarkPage
          size="A4"
          style={styles.page}
          bookmark={{ title: "Ticket summary", ref: BOOKMARK_REF.summary }}
        >
          <RunningHeader title={title} />
          <Footer label={footer} />
          <Section
            title="Ticket summary"
            eyebrow={`${data.summaries.length} beyond the detail cap`}
          >
            <BoundingNote bounding={data.bounding} />
            <SummaryTable summaries={data.summaries} />
          </Section>
        </BookmarkPage>
      ) : null}

      {/* One page per ticket. `break` is not needed — a new <Page> is the break —
          and it keeps each ticket's section starting at a predictable place. */}
      {data.tickets.length === 0 ? (
        <BookmarkPage
          size="A4"
          style={styles.page}
          bookmark={{ title: "Ticket detail", ref: BOOKMARK_REF.tickets }}
        >
          <RunningHeader title={title} />
          <Footer label={footer} />
          <Section title="Ticket detail" eyebrow="Tickets">
            <Text style={styles.muted}>This project has no tickets to detail.</Text>
          </Section>
        </BookmarkPage>
      ) : (
        data.tickets.map((ticket, i) => (
          <BookmarkPage
            key={ticket.ticket.id}
            size="A4"
            style={styles.page}
            // The first ticket page owns the "Ticket detail" outline entry; every
            // ticket section then nests beneath it via `bookmarkParent`.
            bookmark={i === 0 ? { title: "Ticket detail", ref: BOOKMARK_REF.tickets } : undefined}
          >
            <RunningHeader title={title} />
            <Footer label={footer} />
            <View>
              <TicketSection
                data={ticket}
                bookmarkRef={ticketBookmarkRef(i)}
                bookmarkParent={BOOKMARK_REF.tickets}
              />
            </View>
          </BookmarkPage>
        ))
      )}
    </Document>
  );
}
