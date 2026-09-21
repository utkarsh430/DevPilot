# Review artifacts — per-agent model pickers

Screenshots backing the "Workstream A - UI" PR. They are committed here only
because this is a private repo, so GitHub's own attachment upload (which needs a
web session) was not available from the CLI.

**Safe to delete once the PR is reviewed.**

Captured against local Supabase fixtures — three projects covering every state
the picker must render: a pinned Claude model, an unpinned "account default",
and an `openai_compatible` endpoint that cannot serve Claude at all.

| File                        | Shows                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `01-agents.png`             | `/agents` — the resolved model per agent, replacing the `modelTier` badge                                           |
| `02-agents-popover.png`     | `/agents` — popover expanded: an Opus override, an inherited default, and the inert custom endpoint with its reason |
| `03-scoreboard.png`         | `/scoreboard` — the Model column as a control, all 13 columns legible                                               |
| `04-scoreboard-popover.png` | `/scoreboard` — per-project sub-list, scoped to the role's own projects                                             |
| `05-scoreboard-768.png`     | `/scoreboard` at 768px — the table scrolls horizontally rather than compressing                                     |
