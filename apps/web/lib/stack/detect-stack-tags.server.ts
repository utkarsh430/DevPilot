// Phase 2.5++ / WI-15 — the IO half of import-time stack detection.
//
// Fetches the fixed `SCAN_PATHS` manifest list from a connected repo and hands
// the bodies to the pure `detectStackTags`. Kept apart from the pure module so
// the detector stays unit-testable (the Vitest suites in `lib/**/__tests__`
// can't load anything that reaches for the network or Next's server APIs).
//
// Security posture is inherited, not re-invented:
//   • `fetchRawFile` (lib/github/raw.ts) — FIXED `raw.githubusercontent.com`
//     host, 5s timeout, scoped to the caller's own OAuth token. No caller
//     anywhere supplies a base URL.
//   • Every file is byte-capped at `SCAN_FILE_MAX_BYTES` before it is looked
//     at, so a 40 MB lockfile costs us 64 KB of scanning.
//   • A missing file, a 404, a timeout, or a network error is silently "no
//     signal" — detection is a convenience, never a gate. It cannot fail a
//     project create.

import { fetchRawFile } from "@/lib/github/raw";
import {
  SCAN_FILE_MAX_BYTES,
  SCAN_PATHS,
  detectStackTags,
  type ScannedFile,
} from "@/lib/stack/detect-stack-tags";
import type { ServiceCatalogEntry } from "@/lib/stack/service-catalog";

export async function scanRepoForStackTags(args: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}): Promise<ServiceCatalogEntry[]> {
  const settled = await Promise.all(
    SCAN_PATHS.map(async (path): Promise<ScannedFile | null> => {
      try {
        const content = await fetchRawFile(
          args.owner,
          args.repo,
          args.branch,
          args.token,
          path,
          SCAN_FILE_MAX_BYTES,
        );
        return content === null ? null : { path, content };
      } catch {
        // fetchRawFile already swallows its own errors; this is belt-and-braces
        // so one unexpected throw can't reject the whole Promise.all and turn a
        // best-effort convenience into a failed project create.
        return null;
      }
    }),
  );
  const files = settled.filter((f): f is ScannedFile => f !== null);
  return detectStackTags(files);
}
