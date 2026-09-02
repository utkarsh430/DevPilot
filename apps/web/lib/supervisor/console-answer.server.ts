// The supervisor console's model call. Thin by design: everything that decides
// anything - the prompt, the schema, the grounding - is in the pure
// `console-brief.ts`, so this file is the seam and nothing else.
//
// ── TIER `heavy` (Opus), AND WHY THIS ONE SURFACE EARNS IT ────────────────
// Almost every other one-shot in this codebase is `cheap` (Haiku): dependency
// suggestion, capability inference, lesson extraction, dispatch classification.
// Those rank or label something a human then reviews, and being wrong costs a
// discarded suggestion.
//
// This one is read by an operator who will act on it, usually while something
// is broken and they are already short of patience. It has to hold ten kinds of
// evidence about forty tickets in its head at once and pick the ONE that
// explains the board - and the failure mode is not a bad suggestion, it is a
// confident wrong story that sends someone to fix a thing that is not broken.
// So it is the one place where reasoning quality outranks cost, and it is a
// single call per operator question rather than a per-dispatch tax.
//
// ⚠️ WHERE THE TIER ACTUALLY BINDS, stated plainly rather than implied.
// `generateObjectForTenant` routes two ways, and the tier reaches only one of
// them today:
//
//   • api_key mode / any non-Anthropic provider → the DIRECT path, where
//     `heavy` resolves through `MODEL_IDS` to Opus. The tier binds.
//   • claude_code mode (the DEFAULT) → the local-cc runner. The tier is
//     forwarded in the job payload and the runner IGNORES it - `claude -p`
//     emits `--model` only when the project pins `llm_model`, otherwise it
//     runs the subscription's own default. `invokeLocalCcOneShot`'s header
//     says so outright ("forward-compat, not behaviour").
//
// So on a default install this asks for Opus and gets whatever the operator's
// Claude subscription is configured to run. `heavy` is still the right
// declaration - it binds wherever it can, and it is what a future runner-side
// `--model` for one-shots would key on - but do NOT read it as a guarantee that
// this call is answered by Opus. Closing that gap means teaching the runner to
// honour `modelTier` on one-shot jobs, which is a runner change, not a change
// here.
//
// It routes through `generateObjectForTenant` - never a vendor SDK - so it
// honours the tenant's LLM auth mode and the project's provider exactly like
// every other feature.
//
// EVERY FAILURE DEGRADES. There is no throw path: a downed runner, a timeout,
// an unparseable reply and a schema mismatch all come back as
// `{ ok: false, error }` with actionable copy, because the deterministic half
// of the console - the board summary and the available actions - is computed
// without the model and must still be shown when the model cannot be reached.

import "server-only";

import { generateObjectForTenant, type LlmFailureKind } from "@/lib/llm/generate.server";
import {
  CONSOLE_REPLY_SCHEMA_HINT,
  ConsoleReplySchema,
  buildConsolePrompt,
  buildConsoleSystemPrompt,
  groundConsoleReply,
  type ConsoleTurn,
  type GroundedConsoleReply,
} from "@/lib/supervisor/console-brief";
import type { ConsoleAction } from "@/lib/supervisor/console-actions";
import type { ConsoleCommand } from "@/lib/supervisor/console-commands";
import type { ConsoleSnapshot } from "@/lib/supervisor/console-facts";

/** Generous: this prompt is long (a whole board) and the answer is read by a
 *  waiting human, but the local-cc path polls, so the ceiling has to clear a
 *  queued job on a busy runner. */
const CONSOLE_TIMEOUT_MS = 180_000;

/** Anything the operator may run: a recovery ACTION or an operator COMMAND.
 *  Both are derived server-side and grounded by the same rule, so the model
 *  cannot tell them apart and does not need to. */
export type ConsoleOffer = ConsoleAction | ConsoleCommand;

export type ConsoleAnswerResult =
  | { ok: true; reply: GroundedConsoleReply<ConsoleOffer> }
  /** `kind` is carried through UNTRANSLATED. The console needs to tell "the
   *  model was never reached" from "the model answered and could not be read" -
   *  they have different fixes - and this seam is not the place that decides
   *  the wording. `describeConsoleModelFailure` is. */
  | {
      ok: false;
      error: string;
      kind: LlmFailureKind;
      /**
       * The model's own unusable reply, when there was one.
       *
       * CARRIED, NOT GROUNDED - and that distinction is the whole safety
       * argument for showing it. `groundConsoleReply` is what turns a reply into
       * recommendations, and it never runs on this, so a raw reply reaches the
       * operator as PROSE with no action attached, no ticket linked and nothing
       * to click. The structural defence is untouched (`ConsoleReplySchema` has
       * no target field, and an id outside the server-computed offer list is
       * dropped) because there is no id here to drop.
       */
      rawReply?: string;
    };

export async function answerConsoleQuestion(args: {
  tenantId: string;
  projectId: string;
  snapshot: ConsoleSnapshot;
  actions: readonly ConsoleAction[];
  /** Commands derived from THIS message's operator-named tickets. */
  commands: readonly ConsoleCommand[];
  question: string;
  history: readonly ConsoleTurn[];
}): Promise<ConsoleAnswerResult> {
  const offers: ConsoleOffer[] = [...args.actions, ...args.commands];
  const res = await generateObjectForTenant({
    tenantId: args.tenantId,
    projectId: args.projectId,
    featureName: "The supervisor console",
    tier: "heavy",
    system: buildConsoleSystemPrompt(),
    prompt: buildConsolePrompt({
      snapshot: args.snapshot,
      actions: args.actions,
      commands: args.commands,
      question: args.question,
      history: args.history,
    }),
    schema: ConsoleReplySchema,
    schemaHint: CONSOLE_REPLY_SCHEMA_HINT,
    // Deterministic. Two operators asking the same question of the same board
    // should get the same account of it; this is a diagnosis, not a draft.
    temperature: 0,
    timeoutMs: CONSOLE_TIMEOUT_MS,
  });

  if (!res.ok) return { ok: false, error: res.error, kind: res.kind, rawReply: res.rawReply };
  // Re-grounded against the offers WE computed - the recovery actions derived
  // from board state, and the commands derived from the OPERATOR'S OWN message.
  // See `console-brief.ts` and `console-commands.ts` for why this is the
  // structural half of the injection defence rather than a tidy-up.
  return { ok: true, reply: groundConsoleReply<ConsoleOffer>(res.object, offers, args.snapshot) };
}
