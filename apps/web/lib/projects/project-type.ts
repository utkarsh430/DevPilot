// WI-11 — Project platform ("project type").
//
// The operator picks the target platform once, at project creation/import. It
// lives on `projects.project_type` and drives exactly two things:
//
//   • the dev/preview command (`lib/dev-servers/stack-detect.ts`) — the label
//     COARSELY steers which family of commands we look for on disk, replacing
//     the old "guess purely from whatever files happen to be there" heuristic;
//   • plan mode (`lib/plan/prompts.ts`) — the platform is rendered as a HARD
//     frame in the shared project block so the panel agents don't propose
//     Next.js routes for an iOS app.
//
// Deliberately dependency-free (constants only, no imports): `load.ts` is
// server-only (it pulls in the service-role Supabase client) and `stack-detect`
// must stay importable from the pure/unit-tested side of the tree. Keeping the
// type in its own module is what lets all three seams share it without a cycle.
//
// `other` is the DEFAULT and is load-bearing, not a filler value: every row
// that predates the migration gets it, and it means "no claim about the
// platform" — it adds no plan frame and no command steering, so a legacy
// project behaves byte-for-byte as it did before WI-11. A new platform steers
// only when the operator actually asserted one.

export type ProjectType = "web" | "mobile" | "ios" | "desktop" | "other";

export const PROJECT_TYPES: ReadonlyArray<ProjectType> = [
  "web",
  "mobile",
  "ios",
  "desktop",
  "other",
];

export const DEFAULT_PROJECT_TYPE: ProjectType = "other";

export type ProjectTypeConfig = {
  /** Operator-facing label in the platform picker. */
  displayName: string;
  /** One-line "what this means" pitch shown under the label. */
  description: string;
  /**
   * The HARD frame injected into every plan-mode prompt (panels +
   * consolidator). `null` for `other` — an unasserted platform must not
   * constrain the planner, otherwise the default would silently narrow every
   * legacy project's plan.
   */
  planFrame: string | null;
};

export const PROJECT_TYPE_CONFIG: Record<ProjectType, ProjectTypeConfig> = {
  web: {
    displayName: "Web",
    description: "Browser app or web service — Next.js, Vite, Rails, FastAPI, …",
    planFrame:
      "This is a **web** project. Every ticket must target the web platform (browser UI and/or a server that speaks HTTP). Do NOT propose native mobile screens, App Store / Play Store submission work, or desktop packaging (Electron/Tauri installers, code signing, auto-update).",
  },
  mobile: {
    displayName: "Mobile",
    description: "Cross-platform mobile app — React Native, Expo, or Flutter.",
    planFrame:
      "This is a **mobile** project (React Native / Expo / Flutter). Every ticket must target the mobile platform: native screens and navigation, device APIs, and the iOS/Android build+release pipeline. Do NOT propose browser-only work (server-side rendering, SEO, web routing) or desktop packaging. A backend API is in scope only when the mobile app needs it — describe it as the app's backend, never as the product surface.",
  },
  ios: {
    displayName: "iOS",
    description: "Native Apple app — Swift / SwiftUI, built with Xcode.",
    planFrame:
      "This is a native **iOS** project (Swift / SwiftUI, built with Xcode). Every ticket must target Apple's platform: SwiftUI or UIKit views, Apple frameworks, Xcode project/scheme configuration, simulator + device testing, and App Store distribution. Do NOT propose web frameworks (React, Next.js), cross-platform mobile runtimes (React Native, Expo, Flutter), or desktop packaging.",
  },
  desktop: {
    displayName: "Desktop",
    description: "Installable desktop app — Electron, Tauri, or native.",
    planFrame:
      "This is a **desktop** project (Electron / Tauri / native). Every ticket must target the desktop platform: windowed UI, the main/renderer (or Rust/webview) process split, filesystem and OS integration, and packaging/code-signing/auto-update per OS. Do NOT propose native mobile screens or store submission, and do not treat this as a hosted web app — there is no server to deploy unless a ticket explicitly needs one.",
  },
  other: {
    displayName: "Other",
    description: "Something else — CLI, library, data pipeline, or unsure. No platform steering.",
    // Intentionally null. See the module header: the default must not constrain.
    planFrame: null,
  },
};

/** Narrow an untrusted string (DB value, form field) to a ProjectType. */
export function isProjectType(value: unknown): value is ProjectType {
  return typeof value === "string" && (PROJECT_TYPES as ReadonlyArray<string>).includes(value);
}

/**
 * Coerce a possibly-null/unknown value to a ProjectType, falling back to the
 * default. Used at every trust boundary (DB row → domain, prompt context) so a
 * value written by an older/newer schema can never crash a Run or a plan.
 */
export function toProjectType(value: unknown): ProjectType {
  return isProjectType(value) ? value : DEFAULT_PROJECT_TYPE;
}
