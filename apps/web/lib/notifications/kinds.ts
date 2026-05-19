// Catalog of notification kinds — the single source of truth for the
// settings page (labels + defaults) and the in-app delivery rules.
//
// The string literals here MUST stay in lockstep with the CHECK constraint
// on `notifications.kind` (see 20260608000000_notifications.sql). If you
// add a kind: bump the CHECK, add an entry to NOTIFICATION_KIND_CATALOG,
// and grep the codebase for `NotificationKind` to surface compile errors
// in the publisher call-sites.
//
// v1 wiring status (see publish.ts call-sites):
//   • plan.started, plan.finished,
//     plan.failed                      → wired in lib/plan/inngest.ts
//   • run.*, ticket.*, push.*          → kind defined, settings UI lists
//                                        them, but the Inngest emit sites
//                                        are TODO. They require a domain
//                                        decision on recipient (tickets
//                                        and pushes have no per-user owner
//                                        column today). Tracked separately.

export const NOTIFICATION_KINDS = [
  "plan.started",
  "plan.finished",
  "plan.failed",
  "run.completed",
  "run.failed",
  "ticket.assigned_to_me",
  "ticket.input_required",
  "push.merged",
  "push.blocked",
  "push.needs_merger",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationChannelPrefs = {
  inApp: boolean;
  toast: boolean;
};

export type NotificationKindEntry = {
  /** Human label for the settings page table row. */
  label: string;
  /** One-line help text describing when the notification fires. */
  description: string;
  /** Coarse group used to chunk the prefs UI. */
  group: "Planning" | "Runs" | "Tickets" | "Integration branch";
  /** Channel defaults applied when no preferences row exists for this kind. */
  defaults: NotificationChannelPrefs;
};

export const NOTIFICATION_KIND_CATALOG: Record<NotificationKind, NotificationKindEntry> = {
  "plan.started": {
    label: "Plan started",
    description: "The lead planner picked up your prompt and started thinking.",
    group: "Planning",
    defaults: { inApp: true, toast: true },
  },
  "plan.finished": {
    label: "Plan finished",
    description: "The multi-agent panel produced your proposed tickets.",
    group: "Planning",
    defaults: { inApp: true, toast: true },
  },
  "plan.failed": {
    label: "Plan failed",
    description: "The planning panel errored before it could finish.",
    group: "Planning",
    defaults: { inApp: true, toast: true },
  },
  "run.completed": {
    label: "Run completed",
    description: "An agent run finished successfully.",
    group: "Runs",
    defaults: { inApp: true, toast: false },
  },
  "run.failed": {
    label: "Run failed",
    description: "An agent run hit its retry ceiling and failed.",
    group: "Runs",
    defaults: { inApp: true, toast: true },
  },
  "ticket.assigned_to_me": {
    label: "Ticket assigned to me",
    description: "Someone moved a ticket to your queue.",
    group: "Tickets",
    defaults: { inApp: true, toast: true },
  },
  "ticket.input_required": {
    label: "Ticket needs my input",
    description: "An agent paused a ticket waiting on your comment.",
    group: "Tickets",
    defaults: { inApp: true, toast: true },
  },
  "push.merged": {
    label: "Push merged",
    description: "A dev→main push landed cleanly on the integration branch.",
    group: "Integration branch",
    defaults: { inApp: true, toast: false },
  },
  "push.blocked": {
    label: "Push blocked",
    description: "A push hit a conflict and couldn't merge.",
    group: "Integration branch",
    defaults: { inApp: true, toast: true },
  },
  "push.needs_merger": {
    label: "Push needs a human merger",
    description: "Auto-merge gave up; a human merger has been spawned.",
    group: "Integration branch",
    defaults: { inApp: true, toast: true },
  },
};

export function defaultsForKind(kind: NotificationKind): NotificationChannelPrefs {
  return NOTIFICATION_KIND_CATALOG[kind].defaults;
}
