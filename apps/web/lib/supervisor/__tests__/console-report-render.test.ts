// The console's deterministic panel, rendered for real.
//
// It lives under `lib/**/__tests__/` rather than beside the component because
// Vitest here collects only that path, in a NODE environment - which is also
// why `console-report.tsx` carries no hook, no browser API and no
// provider-bearing primitive. Move state into it and it silently leaves this
// suite (the `skill-preview-render.test.ts` shape).

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ConsoleReport, EngineStrip } from "@/components/supervisor/console-report";
import type { ConsoleBrief } from "@/lib/supervisor/console-view";
import type { ConsoleAction } from "@/lib/supervisor/console-actions";

const ACTION: ConsoleAction = {
  id: "recover_stalled_ticket:t1",
  kind: "recover_stalled_ticket",
  cause: "stalled_ticket",
  label: "Unstick DevPilot-27",
  consequence: "Moves DevPilot-27 to Input required. It does NOT re-run the work.",
  ticketId: "t1",
  ticketKey: "DevPilot-27",
};

function brief(over: Partial<ConsoleBrief> = {}): ConsoleBrief {
  return {
    projectName: "scoursh",
    supervisorEnabled: true,
    engine: { state: "alive", detail: "last scheduled tick 5s ago" },
    summary: {
      total: 3,
      byWaitingOn: { machine: 1, human: 1, nobody: 1, none: 0 },
      byKind: { stalled: 1 },
      unowned: [{ key: "DevPilot-27", kind: "stalled", detail: "Nothing owns this ticket." }],
      headline: "1 ticket(s) have nobody working on them and nothing scheduled to.",
    },
    actions: [ACTION],
    truncated: false,
    ...over,
  };
}

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

describe("EngineStrip", () => {
  it("renders NOTHING when the engine's recovery is alive", () => {
    // A row that is always present is a row an operator learns to skip, and
    // this is the one fact that reframes every other number on the board.
    expect(render(createElement(EngineStrip, { engine: brief().engine }))).toBe("");
  });

  it("names the dead crons when the engine is wedged", () => {
    const html = render(
      createElement(EngineStrip, {
        engine: { state: "wedged", detail: "last scheduled tick 3600s ago" },
      }),
    );
    expect(html).toContain("scheduled recovery has stopped");
    expect(html).toContain("dispatch rescue");
  });

  it("shows `unknown` rather than hiding it", () => {
    // "We could not tell whether the safety nets are running" is materially
    // different from "they are", and reading the first as the second is the
    // fail-open the autonomous supervisor refuses.
    const html = render(
      createElement(EngineStrip, { engine: { state: "unknown", detail: "never stamped" } }),
    );
    expect(html).toContain("could not be confirmed");
  });
});

describe("ConsoleReport", () => {
  it("shows the headline, the three waiting-on counts and the unowned list", () => {
    const html = render(createElement(ConsoleReport, { brief: brief() }));
    expect(html).toContain("nobody working on them");
    expect(html).toContain("Nobody");
    expect(html).toContain("The machine");
    expect(html).toContain("Nothing is working on these");
    expect(html).toContain("DevPilot-27");
  });

  it("renders no unowned block at all when nothing is unowned", () => {
    // An empty section that still draws its heading is how "nothing is wrong"
    // starts looking like "something is wrong".
    const html = render(
      createElement(ConsoleReport, {
        brief: brief({
          summary: {
            ...brief().summary,
            unowned: [],
            byWaitingOn: { machine: 3, human: 0, nobody: 0, none: 0 },
          },
        }),
      }),
    );
    expect(html).not.toContain("Nothing is working on these");
  });

  it("always renders each action's consequence beside it, never only the label", () => {
    // An operator has to be able to decline from the description alone: "Unstick
    // DevPilot-27" does not say the ticket comes back to them rather than being
    // re-run.
    const html = render(createElement(ConsoleReport, { brief: brief() }));
    expect(html).toContain("Unstick DevPilot-27");
    expect(html).toContain("does NOT re-run the work");
  });

  it("DISABLES the actions and says why when supervision is off", () => {
    const html = render(
      createElement(ConsoleReport, { brief: brief({ supervisorEnabled: false }) }),
    );
    expect(html).toContain("Supervision is off for this project");
    expect(html).toContain("disabled");
    // …but still shows what could be done, rather than looking like an empty
    // console when the operator has one switch to flip.
    expect(html).toContain("Unstick DevPilot-27");
  });

  it("marks the actions the console recommended for the current question", () => {
    const html = render(createElement(ConsoleReport, { brief: brief(), emphasisIds: [ACTION.id] }));
    expect(html).toContain("recommended");
  });

  it("says the counts are a floor when the scan was truncated", () => {
    const html = render(createElement(ConsoleReport, { brief: brief({ truncated: true }) }));
    expect(html).toContain("a floor, not a total");
  });
});
