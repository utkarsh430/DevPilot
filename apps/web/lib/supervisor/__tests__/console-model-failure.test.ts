// THE DEFECT. The supervisor console answered:
//
//   "I could not reach the model to write that up: The supervisor console
//    returned no parseable JSON — try again."
//
// The model was reached. A one-shot had completed seconds earlier with a
// 3,270-character response. The failure was PARSING - and "restart the runner"
// and "look at what the model said" are different investigations, so one
// sentence claiming both sends the reader at the wrong one.
//
// These assertions are written as ABSENCES as well as presences, because the
// bug was a sentence that was WRONG rather than one that was missing: a test
// that only checked "mentions parsing" would stay green against copy that
// mentioned parsing AND still opened by blaming the connection.

import { describe, it, expect } from "vitest";
import { describeConsoleModelFailure } from "@/lib/supervisor/console-view";

const REACHABILITY_CLAIMS = [/could not reach/i, /unreachable/i, /connection problem(?!s)/i];

/** The kinds that mean THE MODEL ANSWERED. */
const ANSWERED = ["unparseable", "invalid_shape"] as const;
/** The kinds that mean it did not. */
const DID_NOT_ANSWER = ["unreachable", "misconfigured", "call_failed"] as const;

describe("describeConsoleModelFailure", () => {
  it("does not blame reachability when the model answered and could not be read", () => {
    const text = describeConsoleModelFailure(
      "unparseable",
      "The supervisor console answered, but the reply contained no readable JSON — try again.",
    );
    // The exact regression: this string opened with "I could not reach the
    // model to write that up".
    expect(text).not.toMatch(/could not reach/i);
    expect(text.toLowerCase()).toContain("the model answered");
    expect(text).toMatch(/not a connection problem/i);
  });

  it("points at the reply rather than at the runner, and says where it is", () => {
    const text = describeConsoleModelFailure("unparseable", "whatever the seam said");
    // The reply itself is deliberately NOT on screen (it is arbitrarily long and
    // is not ours to render), so the copy has to name where it was written down
    // or the operator has nothing to go and look at.
    expect(text).toMatch(/server log/i);
    expect(text).toContain("[llm]");
  });

  it("a schema mismatch is also not a reachability failure", () => {
    const text = describeConsoleModelFailure("invalid_shape", "answer: expected string");
    expect(text).not.toMatch(/could not reach/i);
    expect(text.toLowerCase()).toContain("the model answered");
  });

  it("STILL says 'could not reach' when that is what happened", () => {
    // The other half of the split. Removing the accusation everywhere would be
    // its own defect - `unreachable` is the case it was written for.
    const text = describeConsoleModelFailure("unreachable", "Your local runner is not connected.");
    expect(text).toMatch(/could not reach the model/i);
  });

  it("a misconfiguration reads as configuration, not as a dead connection", () => {
    const text = describeConsoleModelFailure("misconfigured", "ANTHROPIC_API_KEY is not set.");
    expect(text).not.toMatch(/could not reach/i);
    expect(text).toMatch(/llm settings/i);
  });

  it("an unknown kind degrades to neutral - never to a reachability claim", () => {
    // A kind added later, or a stale client posting none at all, must not
    // silently inherit the accusation this function exists to stop making.
    for (const kind of ["", "something_new", "TIMEOUT"]) {
      const text = describeConsoleModelFailure(kind, "boom");
      for (const claim of REACHABILITY_CLAIMS) {
        expect(text, `kind=${JSON.stringify(kind)}`).not.toMatch(claim);
      }
      expect(text).toContain("boom");
    }
  });

  it("never claims a connection failure for a kind that means the model answered", () => {
    for (const kind of ANSWERED) {
      expect(describeConsoleModelFailure(kind, "e"), kind).not.toMatch(/could not reach/i);
    }
  });

  it("always carries the seam's own error and the brief-is-still-good tail", () => {
    for (const kind of [...ANSWERED, ...DID_NOT_ANSWER, "unknown"]) {
      const text = describeConsoleModelFailure(kind, "SENTINEL-ERROR-TEXT");
      // The underlying message is never swallowed: it is the actionable half.
      expect(text, kind).toContain("SENTINEL-ERROR-TEXT");
      // And the deterministic half of the console keeps working, which is the
      // one reassurance worth repeating in every branch.
      expect(text, kind).toMatch(/board summary above is still current/i);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE SECOND HALF OF THE SAME DEFECT (2026-08-04): the answer was thrown away.
//
// The copy above got the DIAGNOSIS right and still left the operator with
// nothing. The model had written 1,453 characters that answered the question
// well, and every one of them was discarded because the envelope was wrong. An
// answer the operator can read beats a clean failure.
// ───────────────────────────────────────────────────────────────────────────

const REAL_REPLY =
  "Captain, the honest answer is: none of them are confirmed working correctly right now — " +
  "DevPilot-1 is the only active ticket, and its record is mixed at best.";

describe("describeConsoleModelFailure with the reply carried through", () => {
  it("shows what the model actually said", () => {
    const text = describeConsoleModelFailure("unparseable", "no readable JSON", REAL_REPLY);
    expect(text).toContain("DevPilot-1 is the only active ticket");
  });

  it("labels it as unverified, so it is not read as a normal answer", () => {
    const text = describeConsoleModelFailure("unparseable", "no readable JSON", REAL_REPLY);
    // The distinction that matters: nothing here was grounded, so nothing in it
    // is clickable and no recommendation in it was checked against the board.
    expect(text).toMatch(/unverified|not been checked|raw/i);
  });

  it("still explains WHY it is being shown raw", () => {
    const text = describeConsoleModelFailure("unparseable", "no readable JSON", REAL_REPLY);
    expect(text).not.toMatch(/could not reach/i);
    expect(text.toLowerCase()).toContain("the model answered");
  });

  it("shows a schema-rejected reply too", () => {
    const text = describeConsoleModelFailure("invalid_shape", "answer: required", REAL_REPLY);
    expect(text).toContain("DevPilot-1 is the only active ticket");
  });

  // ── CONTAINMENT. The reply is arbitrary model output rendered as markdown,
  // so no sequence in it may let its text reach top level, where it would be
  // indistinguishable from the console's own words.
  //
  // Containment is per LINE, which is why these assert on every line rather
  // than on balanced delimiters: a code fence has exactly one escape sequence
  // (```), and the first version of this used one.
  it("quotes EVERY line of the reply, so nothing can escape to top level", () => {
    const reply = "```\nnot really json\n```\n\n# A heading\n\n> already quoted\n\nplain tail";
    const text = describeConsoleModelFailure("unparseable", "e", reply);
    const start = text.indexOf("not really json");
    expect(start).toBeGreaterThan(0);
    // Every line from the first quoted line to the last is inside the quote.
    const quoted = text.slice(text.lastIndexOf("\n", start) + 1);
    const upToTail = quoted.slice(0, quoted.indexOf("plain tail") + "plain tail".length);
    for (const line of upToTail.split("\n")) {
      expect(line.startsWith(">"), `escaped the quote: ${JSON.stringify(line)}`).toBe(true);
    }
  });

  it("keeps a blank line inside the quote, which is what would end it", () => {
    const text = describeConsoleModelFailure("unparseable", "e", "first\n\nsecond");
    expect(text).toContain("> first\n>\n> second");
  });

  // The whole reply must be READABLE, not merely present. A fenced code block
  // renders `whitespace-pre` and put a 1,400-character paragraph on one clipped
  // line - technically shown, practically not.
  it("does not put the reply in a code fence", () => {
    const text = describeConsoleModelFailure("unparseable", "e", REAL_REPLY);
    expect(text).not.toContain("```");
  });

  it("passes the reply through verbatim - no mangling to protect a delimiter", () => {
    const reply = "use ```json fences``` and `inline` code";
    const text = describeConsoleModelFailure("unparseable", "e", reply);
    expect(text).toContain(`> ${reply}`);
  });

  it("bounds a very long reply", () => {
    const text = describeConsoleModelFailure("unparseable", "e", "x".repeat(50_000));
    expect(text.length).toBeLessThan(8000);
  });

  it("falls back to naming the server log when there is no reply to show", () => {
    // Unchanged behaviour for every caller that has nothing to carry - and the
    // log pointer must not vanish just because the happy path now has one.
    const text = describeConsoleModelFailure("unparseable", "no readable JSON");
    expect(text).toMatch(/server log/i);
    expect(text).toContain("[llm]");
  });

  it("ignores an empty or whitespace reply rather than rendering an empty block", () => {
    for (const raw of ["", "   \n  "]) {
      const text = describeConsoleModelFailure("unparseable", "no readable JSON", raw);
      expect(text).toMatch(/server log/i);
    }
  });

  // A reply is only carried for the two kinds that mean the model answered. A
  // reachability failure has nothing to show, and rendering an empty "here is
  // what it said" block under "I could not reach the model" would be nonsense.
  it("does not render a reply block for a failure that never reached the model", () => {
    for (const kind of DID_NOT_ANSWER) {
      const text = describeConsoleModelFailure(kind, "e", REAL_REPLY);
      expect(text, kind).not.toContain("DevPilot-1 is the only active ticket");
    }
  });
});
