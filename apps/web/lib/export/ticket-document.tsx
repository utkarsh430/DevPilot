// The per-ticket audit document.
//
// Two pages minimum: a cover carrying provenance + the trust notice, then the
// ticket itself. Every heading is a `bookmark`, so the PDF ships a real outline
// — the navigation an auditor actually uses in a 40-page artifact, and something
// an HTML-print pipeline cannot produce without a paged-media polyfill.

import React from "react";
import { Document, View } from "@react-pdf/renderer";
import { BookmarkPage, styles } from "@/lib/export/components/primitives";
import { Cover, Footer, RunningHeader, TRUST_NOTICE } from "@/lib/export/components/Chrome";
import { TicketSection, ticketKey } from "@/lib/export/components/TicketSection";
import { formatCents, formatTimestamp, type TicketAuditExport } from "@/lib/export/types";
import { BOOKMARK_REF, ticketBookmarkRef } from "@/lib/export/bookmarks";

export function TicketDocument({
  data,
  generatedAt,
  projectName,
}: {
  data: TicketAuditExport;
  generatedAt: string;
  projectName?: string | null;
}) {
  const t = data.ticket;
  const key = ticketKey(t.ticketNumber, t.id);
  const title = `${key} — ${t.title.value}`;

  return (
    <Document
      title={title}
      author="DevPilot"
      subject="Ticket audit export"
      creator="DevPilot"
      producer="DevPilot"
    >
      {/* Cover */}
      <BookmarkPage
        size="A4"
        style={styles.page}
        bookmark={{ title: "Cover", ref: BOOKMARK_REF.cover }}
      >
        <Footer label={`${key} · audit export`} />
        <Cover
          eyebrow="Ticket audit export"
          title={key}
          subtitle={t.title.value}
          notice={TRUST_NOTICE}
          meta={[
            { label: "Project", value: projectName ?? "—" },
            { label: "Status", value: t.status.replace(/_/g, " ") },
            { label: "Runs", value: String(data.runs.length) },
            {
              label: "Total spend",
              value: data.cost.costPriced
                ? formatCents(data.cost.totalCents)
                : `${formatCents(data.cost.totalCents)} (partially unpriced)`,
            },
            { label: "Created", value: formatTimestamp(t.createdAt) },
            { label: "Last updated", value: formatTimestamp(t.updatedAt) },
            { label: "Generated", value: formatTimestamp(generatedAt) },
          ]}
        />
      </BookmarkPage>

      {/* Record */}
      <BookmarkPage
        size="A4"
        style={styles.page}
        bookmark={{ title: key, ref: BOOKMARK_REF.ticketRecord }}
      >
        <RunningHeader title={title} />
        <Footer label={`${key} · audit export`} />
        <View>
          <TicketSection data={data} bookmarkRef={ticketBookmarkRef(0)} standalone={false} />
        </View>
      </BookmarkPage>
    </Document>
  );
}
