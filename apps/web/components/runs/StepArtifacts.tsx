"use client";

import * as React from "react";
import { ARTIFACT_PRECISION_NOTE, describeRetention, type RunArtifact } from "@/lib/runs/artifacts";

function formatCapturedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The screenshots an agent captured through the browser during one step.
 *
 * Two pieces of copy here are load-bearing rather than decorative, and both are
 * about not over-claiming:
 *
 *  • The PRECISION note. DevPilot can prove which STEP wrote each image (the
 *    browser server ran inside exactly one `claude -p` invocation, with an
 *    output directory unique to it) but not which action inside the step. An
 *    operator who believes an image is pinned to a specific tool call will read
 *    a false story into it with full confidence, so the limit is stated and each
 *    image carries its capture time for ordering.
 *
 *  • The RETENTION line. A step is capped at four kept images, and a cap the
 *    operator cannot see is indistinguishable from "that is all there was".
 *    `capturedTotal` travels with every row precisely so this can say "showing
 *    4 of 9" instead of quietly showing 4.
 */
export function StepArtifacts({ artifacts }: { artifacts: readonly RunArtifact[] }) {
  if (artifacts.length === 0) return null;

  // Every row of a step carries the same captured_total; take the largest seen
  // so a partially-failed upload still reports against the real capture count.
  const capturedTotal = artifacts.reduce((m, a) => Math.max(m, a.capturedTotal), artifacts.length);

  return (
    <section>
      <h3 className="text-muted-foreground mb-1 text-[11px] font-medium uppercase tracking-wide">
        Browser screenshots
      </h3>
      <p className="text-muted-foreground mb-2 text-[11px] leading-relaxed">
        {describeRetention({ shown: artifacts.length, capturedTotal })} {ARTIFACT_PRECISION_NOTE}
      </p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {artifacts.map((a) => (
          <li key={a.id} className="min-w-0">
            {a.url ? (
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block overflow-hidden rounded-md border transition-opacity hover:opacity-90"
                title="Open full size in a new tab"
              >
                {/* Deliberately a plain <img>: the source is a short-lived
                    signed Supabase URL on a host next/image is not configured
                    for, and these are already-sized viewport captures with
                    nothing to gain from the optimizer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.url}
                  alt={`Screenshot ${a.sequence + 1} captured during this step`}
                  loading="lazy"
                  className="bg-background block h-auto w-full"
                />
              </a>
            ) : (
              // The row exists and the image could not be loaded. Say so rather
              // than omitting it — silently showing fewer images is the exact
              // false-negative this feature exists to end.
              <div className="text-muted-foreground flex h-24 items-center justify-center rounded-md border border-dashed px-2 text-center text-[10px]">
                Image stored but could not be loaded
              </div>
            )}
            <div className="text-muted-foreground mt-1 flex items-baseline justify-between gap-2 text-[10px]">
              <span className="font-mono">#{a.sequence + 1}</span>
              <span>{formatCapturedAt(a.capturedAt)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
