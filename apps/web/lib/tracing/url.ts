// Build a deep link into a Langfuse trace.
//
// Langfuse Cloud routes individual traces under /project/<projectId>/traces/<traceId>.
// Without the project segment the user lands on the org dashboards page.
// If LANGFUSE_PROJECT_ID isn't set we return null so the UI can hide the link
// rather than send users to a 404.

export function langfuseTraceUrl(
  baseUrl: string,
  projectId: string,
  traceId: string,
): string | null {
  if (!projectId) return null;
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/project/${projectId}/traces/${traceId}`;
}

/**
 * Deep link to a specific Langfuse observation (generation / span / event)
 * inside a trace. Langfuse Cloud's trace detail page reads the
 * `?observation=<id>` query param to select and scroll to the observation in
 * the right-hand panel — this is the same anchor the in-app "share" button
 * produces. Source: Langfuse Cloud trace UI (verified against
 * us.cloud.langfuse.com as of the M8 carry-over fix; the alternative
 * `#observation-<id>` hash anchor does NOT work, the page only reads the
 * query param).
 *
 * Returns null when the project id isn't configured so callers can fall back
 * to the plain trace URL (or hide the link entirely for legacy steps that
 * never persisted an observation id).
 */
export function langfuseObservationUrl(
  baseUrl: string,
  projectId: string,
  traceId: string,
  observationId: string,
): string | null {
  if (!projectId) return null;
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/project/${projectId}/traces/${traceId}?observation=${observationId}`;
}
