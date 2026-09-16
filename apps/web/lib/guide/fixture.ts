// The guide fixture's fixed identifiers - shared by the seed SQL, the capture
// script and the tests.
//
// PURE: no imports, no `server-only`, no node builtins. A `.mjs` script, Vitest
// and (in principle) a renderer all load this, and the whole point of the file
// is that exactly one literal exists for each id.
//
// ── Why these are constants rather than "whatever is in the database" ───────
//
// The capture script refuses to run unless the tenant it resolves equals
// `GUIDE_FIXTURE_TENANT_ID`. That refusal is one of the two independent keys
// standing between a capture run and the operator's REAL board - the other
// being that the Supabase host must resolve to localhost. Either key alone is
// defeatable by a stray `.env.local`: a local host still holds whatever a
// developer has been working on, and a matching tenant id could in principle be
// created anywhere. Together they are not defeatable by accident, which is the
// bar that matters - "forgot to switch databases" is the realistic threat here,
// not an adversary.
//
// A screenshot that leaks a real project name, a real ticket title or a real
// customer's issue into a shipped manual is not recoverable: the PDF is
// downloaded, the page is cached, and the discovery is made by a stranger.
// Redaction-after-capture was considered and REJECTED - it is a human step whose
// failure is silent and permanent. Refusing to start is a failure that is loud
// and costs nothing.
//
// Every id shares the `9de1de00` prefix, which reads as "guide00" - so a fixture
// row that escapes into a real database is recognisable on sight rather than
// looking like any other uuid.

/** The fixture tenant. The capture script refuses to run against any other. */
export const GUIDE_FIXTURE_TENANT_ID = "9de1de00-0000-4000-a000-000000000001";

/** The fixture project every captured screen belongs to. Fictional. */
export const GUIDE_FIXTURE_PROJECT_ID = "9de1de00-0000-4000-a000-000000000002";

/** The completed run the runner figure depicts. */
export const GUIDE_FIXTURE_RUN_ID = "9de1de00-0000-4000-a000-000000000003";

/**
 * The run that FAILED, and says why.
 *
 * A guide that only ever photographs a green run has not shown the reader the
 * screen they will actually open when something is wrong - which is the one
 * the troubleshooting section sends them to first.
 */
export const GUIDE_FIXTURE_FAILED_RUN_ID = "9de1de00-0000-4000-a000-000000000005";

// ── The three tickets the drawer figures open ──────────────────────────────
//
// One ticket per figure, rather than three crops of one drawer. A drawer's
// layout depends on the ticket's own data - a longer title wraps to two lines
// and shifts everything below it - so three figures sharing one ticket would
// all reframe together on any edit to it, and the freshness gate cannot see
// fixture data at all.

/** `input_required`, carrying the agent's question in its thread. */
export const GUIDE_FIXTURE_INPUT_REQUIRED_TICKET_ID = "9de1de00-0000-4000-a000-000000000014";

/** `in_progress`, and `builds_on` another ticket that has not finished. */
export const GUIDE_FIXTURE_BUILDS_ON_TICKET_ID = "9de1de00-0000-4000-a000-000000000013";

/** `in_review`, used for the safety-flag card. */
export const GUIDE_FIXTURE_IN_REVIEW_TICKET_ID = "9de1de00-0000-4000-a000-000000000015";

/**
 * The operator the capture script signs in as.
 *
 * A real address is never used: local GoTrue delivers to Inbucket, and the
 * capture script reads the sign-in link back out of it. `example.com` is
 * reserved by RFC 2606 precisely so it cannot reach anybody.
 */
export const GUIDE_FIXTURE_USER_EMAIL = "guide-capture@example.com";

/** Shown in the topbar project switcher, so it appears in figure chrome. */
export const GUIDE_FIXTURE_PROJECT_NAME = "Harbour Lights";
