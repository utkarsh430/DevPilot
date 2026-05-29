import { describe, expect, it } from "vitest";
import { formatTicketKey, shortTicketId } from "@/lib/board/ticket-key";

const ID = "9f3a1c2e-1111-4444-8888-abcdefabcdef";

describe("formatTicketKey", () => {
  it("renders the human-friendly DevPilot-<N> key when the ticket is numbered", () => {
    expect(formatTicketKey(1, ID)).toBe("DevPilot-1");
    expect(formatTicketKey(142, ID)).toBe("DevPilot-142");
  });

  it("falls back to the short hex id for a project-less (unnumbered) ticket", () => {
    // A ticket with `project_id IS NULL` has no per-project counter to number
    // it. It must still show SOMETHING — never a blank identity.
    expect(formatTicketKey(null, ID)).toBe("9f3a1c");
    expect(formatTicketKey(undefined, ID)).toBe(shortTicketId(ID));
  });
});
