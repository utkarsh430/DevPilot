// The empty-delivery seam: tell the agent it committed nothing WHILE IT CAN
// STILL COMMIT.
//
// THE DEFECT (measured on project `scoursh`, 2026-08-03)
// ─────────────────────────────────────────────────────
// Three tickets, one shape. Each had a workspace full of the agent's own
// modified files and ZERO commits on its branch:
//
//   #27  6 modified files,                    0 commits → gate refused, parked `blocked`
//   #86  3 modified files + an untracked dir, 0 commits → gate refused twice (gate_retry_count 2)
//   #88  4 modified files,                    0 commits → gate refused, parked `blocked`
//
// The fact that rules out "three careless agents": run `384996f1` for #27
// finished **`done`**. A successful run left its own deliverable uncommitted,
// and #86's edits sat untouched for 20+ minutes across a re-dispatch, so they
// were not being recreated each time either.
//
// WHY IT COULD NOT SELF-CORRECT
// ─────────────────────────────
// `applyEngineerPost` advances `in_progress → in_review` at the END of the run,
// whatever was committed. So the ticket always reached `decideQaGate`, which
// correctly refused `empty_delivery` (`commitsAhead === 0` AND `codeProducing`)
// — but by then `claude -p` had exited. Per AGENTS.md the live MCP
// `devpilot_move_ticket` path returns 422 so an agent can retry in-session,
// while the ENGINE paths (engineer postprocess, reconciler, aggregator) park to
// `blocked`; the built-in `engineer` role never calls the tool, so it only ever
// met the gate on the parking path and received no signal it could act on.
// Re-dispatch reproduced it exactly — four attempts across those three tickets.
//
// THE GATE IS RIGHT AND IS NOT WEAKENED. The defect is WHEN the agent learns,
// not WHAT the gate decides. `decideQaGate` is untouched and remains the
// backstop: everything here happens strictly BEFORE it, and a nudge that fails
// leaves it to refuse exactly as it does today.
//
// WHY THE SEAM IS HERE AND NOWHERE ELSE
// ─────────────────────────────────────
// The runner is the ONLY process that holds the workspace and can still spawn a
// turn against it. Every other candidate was considered and cannot work:
//
//   • the ENGINE (`role-post` / the reconciler) runs after `claude -p` exited;
//     its only lever is a fresh dispatch, which is a NEW run with a fresh
//     prompt — i.e. exactly the loop that already ran four times and changed
//     nothing.
//   • the MCP relay (hook (i)) fires only when the agent calls
//     `devpilot_move_ticket`, and the engineer never does.
//   • the PROMPT already carries this instruction — engineer's safety contract
//     has a VERIFY-BEFORE-CLAIMING clause — and it did not hold. A mechanism
//     that depends on the agent remembering is what failed.
//
// So: after `claude -p` returns and before the step result is reported, measure
// the branch. On the exact defect shape, spend ONE more `claude -p` turn in the
// SAME workspace whose whole job is to commit the work already on disk.
//
// NO NEW CONFIGURATION SWITCH, DELIBERATELY. AGENTS.md records the B2 finding
// that "an enforcement switch whose evidence supply is configured elsewhere is
// not an enforcement switch" — `ENGINEER_QA_GATE_ENABLED` (engine) and
// `ENGINEER_QA_VERIFY_ENABLED` (runner host) were two flags in two processes,
// and prod sat in the silently-invalid combination for 20 consecutive rejects.
// A third flag would be a third way to be half-configured. This fires on FACTS
// instead: an engine-stamped role property plus two local git reads. There is
// no configuration under which "a code-producing role, a prepared workspace,
// zero commits on the branch, and uncommitted edits on disk" is a state anyone
// wants, so there is nothing to switch off. It is also independent of the QA
// gate flag on purpose: with the gate OFF the same empty hand-off reaches QA
// and burns a QA run plus an engineer retry (the original 66.7%-reject
// finding), so the instances that most need this are the ones a gate-coupled
// fix would skip.

/** Bounded number of `git status --porcelain` entries quoted back to the agent.
 *  Enough to name the untracked directory that made #86 unfixable by
 *  `git commit -a`; short enough that a repo with a large dirty tree cannot
 *  crowd out the instruction itself. */
export const NUDGE_STATUS_ENTRY_CAP = 40;

/** Facts the decision is made from. Every one is either engine-stamped or read
 *  from local git; nothing here is agent-supplied. */
export type CommitNudgeInput = {
  /**
   * Engine-stamped `isCodeProducingRole(role)`. STAMPED, NOT RE-DERIVED HERE,
   * for the same reason `requiresWorkspace` is (AGENTS.md, workspace
   * precondition): the engine owns `lib/roles/code-producing.ts`, the runner
   * cannot import from `apps/web`, and a second hand-maintained copy of that
   * membership list would drift silently — in the direction that wedges a role.
   *
   * Absent / non-`true` is PERMISSIVE (no nudge). That is what keeps the ~48
   * non-code roles safe: a PM, a designer and a techwriter all finish every run
   * with zero commits, and a check that fired for them would wedge every one.
   * A job from a pre-nudge engine also has no stamp and behaves exactly as
   * today.
   */
  codeProducing?: boolean | null;
  /** The prepared workspace, or null when prep was skipped/produced nothing. */
  workspacePath: string | null;
  /**
   * Commits this branch adds on top of the base branch, from
   * `readGitCommitsAhead`. `0` is a POSITIVE assertion of empty delivery;
   * `null` means we could not measure it and is ALWAYS fail-open — never
   * inferred to be 0. Same rule, and the same reason, as `decideQaGate`'s
   * `delivery-indeterminate`: a missing measurement is not an empty delivery,
   * and spending a turn on the strength of a git failure is exactly the
   * fail-closed behaviour this must not have.
   */
  commitsAhead: number | null;
  /**
   * `git status --porcelain` lines, or null when git could not be read (also
   * fail-open). An EMPTY array is the meaningful negative: nothing on disk to
   * commit.
   *
   * Note `.env.local` cannot appear here — `prepareWorkspace` appends it to
   * `.git/info/exclude` when it writes the project secrets, so the blanket
   * `git add -A` this feature recommends cannot stage it. That guarantee lives
   * in `workspace.ts`; a second filter here would be redundant machinery whose
   * presence would imply the first one is not trusted.
   */
  statusEntries: readonly string[] | null;
  /**
   * Has a nudge already been spent on this step? THE ANTI-LOOP INVARIANT — see
   * `nudge-already-spent` below.
   */
  alreadyNudged: boolean;
};

/** Why no nudge was spent. Named rather than boolean so a runner log says which
 *  branch was taken, and so the fail-open cases are greppable instead of
 *  looking like a legitimate skip. */
export type CommitNudgeSkipReason =
  /** Not a code-producing role (the ~48-role protection, and the default). */
  | "not-code-producing"
  /** No checkout — nothing to measure and nothing to commit into. */
  | "no-workspace"
  /** `commitsAhead === null`. Fail-open, mirroring `delivery-indeterminate`. */
  | "delivery-indeterminate"
  /** The branch already carries work. The healthy case, and the common one. */
  | "delivery-present"
  /** `git status` unreadable. Fail-open. */
  | "worktree-indeterminate"
  /**
   * Zero commits AND a clean tree: the agent genuinely produced nothing, so
   * there is nothing a nudge could ask it to commit. Falls through to
   * `decideQaGate`, which refuses `empty_delivery` and parks the ticket
   * `blocked` — a terminal, reversible, human-visible state, reached in ONE
   * pass. This is the branch that keeps constraint 3 (no bouncing): the
   * nothing-to-commit case is never nudged, so it cannot ping-pong.
   */
  | "nothing-to-commit"
  /**
   * ONE nudge per step, full stop. This is the whole loop bound and it is
   * structural rather than a budget: the caller sets this flag before spending
   * the turn, so a second evaluation in the same step is refused by
   * construction whatever the git reads say. A nudge that fails to produce a
   * commit therefore lands in exactly the same place as `nothing-to-commit` —
   * the gate refuses and the ticket parks `blocked` — instead of retrying.
   */
  | "nudge-already-spent";

export type CommitNudgeDecision =
  | { nudge: false; skipped: CommitNudgeSkipReason }
  | { nudge: true; statusEntries: readonly string[] };

/**
 * Should the runner spend one extra `claude -p` turn asking this agent to
 * commit the work already sitting in its workspace?
 *
 * Pure. The intersection it fires on — code-producing role, real workspace,
 * measured zero commits, measured non-empty worktree — is never a healthy
 * state, and every uncertain input falls open.
 */
export function decideCommitNudge(input: CommitNudgeInput): CommitNudgeDecision {
  // Ordered cheapest-and-most-protective first. `alreadyNudged` is checked
  // ahead of everything else so no future edit to the fact-gathering below can
  // reopen the loop.
  if (input.alreadyNudged) return { nudge: false, skipped: "nudge-already-spent" };
  if (input.codeProducing !== true) return { nudge: false, skipped: "not-code-producing" };
  if (!input.workspacePath) return { nudge: false, skipped: "no-workspace" };
  if (input.commitsAhead === null) return { nudge: false, skipped: "delivery-indeterminate" };
  if (input.commitsAhead > 0) return { nudge: false, skipped: "delivery-present" };
  if (input.statusEntries === null) return { nudge: false, skipped: "worktree-indeterminate" };
  if (input.statusEntries.length === 0) return { nudge: false, skipped: "nothing-to-commit" };
  return { nudge: true, statusEntries: input.statusEntries };
}

/**
 * The system prompt for the nudge turn.
 *
 * Deliberately NOT the engineer's own role prompt. This turn is a fresh
 * `claude -p` session with no memory of the run, and handing it the full role
 * brief would invite it to re-do the task — a second, unbudgeted attempt at the
 * ticket rather than the small bounded act of recording the one already
 * finished. The caller pairs this with a reduced tool set and an MCP config
 * carrying no servers, so the turn cannot move the ticket, file a ticket,
 * comment, escalate to a human, or drive a browser: the only side effect
 * available to it is a git commit in this workspace.
 */
export const COMMIT_NUDGE_SYSTEM_PROMPT = [
  "You are a git-hygiene step at the very end of an engineering run in an existing checkout.",
  "The engineering work is ALREADY DONE and is sitting uncommitted in this working tree.",
  "",
  "Your ONLY job is to record that work as one or more git commits on the current branch.",
  "Do not start new work. Do not refactor. Do not fix tests. Do not add features.",
  "Do not change what the files say beyond what is needed to make a clean, honest commit",
  "(for example adding a `.gitignore` entry so build output is not committed).",
  "",
  "Be brief. Finish by stating what you committed, or by stating plainly that there was",
  "nothing worth committing and why.",
].join("\n");

/**
 * The message the agent gets INSTEAD of a post-mortem refusal it cannot act on.
 *
 * Every clause below is load-bearing:
 *
 *   • `git add -A`, named explicitly. #86's new fixtures directory was
 *     UNTRACKED, so `git commit -a` — the reflex — would have committed three
 *     modified files and silently dropped the fixtures. `-a` stages tracked
 *     modifications only; `-A` stages new files too.
 *   • the no-safety-net statement. AGENTS.md's reap guard protects unpushed
 *     COMMITS only, by design (holding on uncommitted files would pin every
 *     workspace forever on build artifacts). That rule is correct and is not
 *     changed here — but it means an uncommitted edit is genuinely the only
 *     copy and the workspace reaper is entitled to delete it, so the agent is
 *     told so rather than left to assume the platform is holding its work.
 *   • the consequence, stated concretely. "Commit your work" is advice; "the
 *     hand-off will be refused and the ticket parked where you can no longer
 *     act" is the reason it matters, and it is exactly what happened four times.
 *   • the honest escape. A ticket that truly needs no code change must NOT be
 *     answered with a noise commit; saying so is a legitimate outcome, and the
 *     gate then parks the ticket for a human, which is the right end state.
 */
export function renderCommitNudgePrompt(statusEntries: readonly string[]): string {
  const shown = statusEntries.slice(0, NUDGE_STATUS_ENTRY_CAP);
  const omitted = statusEntries.length - shown.length;
  const listing =
    shown.map((line) => `  ${line}`).join("\n") +
    (omitted > 0 ? `\n  … and ${omitted} more entr${omitted === 1 ? "y" : "ies"}` : "");

  return [
    "STOP — your work is not recorded yet.",
    "",
    "The run you just finished produced NO COMMITS on this branch. Whatever you changed is",
    "still uncommitted in this working tree. `git status --porcelain` reports:",
    "",
    listing,
    "",
    "This matters now, and only now:",
    "",
    "  • Handing this ticket to QA claims an implementation exists on this branch. It does not,",
    "    so the hand-off will be REFUSED and the ticket will be parked in `blocked`, after which",
    "    you cannot act on it — a human has to unblock it and the work is re-attempted from",
    "    scratch. That has already happened to this class of run four times.",
    "  • Uncommitted edits have NO safety net. The workspace reaper protects unpushed COMMITS",
    "    only; it does not hold a workspace open for modified-but-uncommitted files. Until you",
    "    commit, this working tree is the only copy and nothing is preserving it.",
    "",
    "Do this now:",
    "",
    "  1. `git status` and `git diff` — confirm these changes are the deliverable you just wrote.",
    "  2. `git add -A` — NOT `git commit -a`. `-a` stages tracked modifications ONLY and will",
    "     silently skip any NEW file or directory you created (a new module, a fixtures folder,",
    "     a new test file). `-A` stages new files too. If `git status` shows build output or",
    "     other generated files you should not ship, add them to `.gitignore` first rather than",
    "     committing them.",
    "  3. Commit with a message describing the change you made.",
    "  4. `git log --oneline -1` — confirm the commit is on THIS branch, not on a detached HEAD.",
    "",
    "If, having looked, there is genuinely nothing here worth committing — the ticket needed no",
    "code change, or everything listed is generated output — then commit NOTHING and say so",
    "plainly in your reply. Do not manufacture a commit to satisfy this message.",
  ].join("\n");
}
