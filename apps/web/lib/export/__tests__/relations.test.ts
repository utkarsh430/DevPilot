// The shared relation-grouping rule. Both the drawer's relations route and the
// audit export lower raw `ticket_dependencies` rows through this, so a
// directionality mistake here would make the two surfaces disagree about what
// blocks what — and an auditor would have no way to tell which was right.

import { describe, expect, it } from "vitest";
import {
  allReferencedIds,
  groupRelationIds,
  isRelationKind,
  BLOCKING_GROUPS,
} from "@/lib/export/relations";

describe("isRelationKind", () => {
  it("accepts the four known flavours and nothing else", () => {
    for (const k of ["blocked_by", "related", "duplicate", "builds_on"]) {
      expect(isRelationKind(k)).toBe(true);
    }
    expect(isRelationKind("supersedes")).toBe(false);
    expect(isRelationKind("")).toBe(false);
  });
});

describe("groupRelationIds", () => {
  it("reads an own blocked_by row as a BLOCKER", () => {
    // `(ticket_id: T, blocks_ticket_id: B, blocked_by)` means "T is blocked_by B".
    const g = groupRelationIds({
      own: [{ blocks_ticket_id: "B", relation_type: "blocked_by" }],
      inverse: [],
    });
    expect(g.blockedBy).toEqual(["B"]);
    expect(g.blocks).toEqual([]);
  });

  it("reads the same row from the other endpoint as BLOCKS", () => {
    const g = groupRelationIds({
      own: [],
      inverse: [{ ticket_id: "T", relation_type: "blocked_by" }],
    });
    expect(g.blocks).toEqual(["T"]);
    expect(g.blockedBy).toEqual([]);
  });

  it("keeps builds_on directional", () => {
    const g = groupRelationIds({
      own: [{ blocks_ticket_id: "PARENT", relation_type: "builds_on" }],
      inverse: [{ ticket_id: "CHILD", relation_type: "builds_on" }],
    });
    expect(g.buildsOn).toEqual(["PARENT"]);
    expect(g.builtOnBy).toEqual(["CHILD"]);
  });

  it("unions both directions for the symmetric flavours", () => {
    const g = groupRelationIds({
      own: [{ blocks_ticket_id: "X", relation_type: "related" }],
      inverse: [{ ticket_id: "Y", relation_type: "related" }],
    });
    expect(g.related.sort()).toEqual(["X", "Y"]);
  });

  it("de-duplicates a symmetric relation recorded from both sides", () => {
    const g = groupRelationIds({
      own: [{ blocks_ticket_id: "X", relation_type: "duplicate" }],
      inverse: [{ ticket_id: "X", relation_type: "duplicate" }],
    });
    expect(g.duplicate).toEqual(["X"]);
  });

  it("DROPS an unknown relation flavour instead of defaulting it into a bucket", () => {
    // A flavour added to the DB but not to this vocabulary must not silently
    // start acting like a blocker — the same bug class as the `related`-wedge.
    const g = groupRelationIds({
      own: [{ blocks_ticket_id: "Z", relation_type: "supersedes" }],
      inverse: [],
    });
    expect(Object.values(g).flat()).toEqual([]);
  });

  it("never treats related/duplicate as blocking", () => {
    const g = groupRelationIds({
      own: [
        { blocks_ticket_id: "R", relation_type: "related" },
        { blocks_ticket_id: "D", relation_type: "duplicate" },
      ],
      inverse: [],
    });
    for (const group of BLOCKING_GROUPS) {
      expect(g[group]).toEqual([]);
    }
  });

  it("is empty for no rows", () => {
    const g = groupRelationIds({ own: [], inverse: [] });
    expect(Object.values(g).flat()).toEqual([]);
  });
});

describe("allReferencedIds", () => {
  it("collects both endpoints, de-duplicated", () => {
    expect(
      allReferencedIds({
        own: [
          { blocks_ticket_id: "A", relation_type: "blocked_by" },
          { blocks_ticket_id: "A", relation_type: "related" },
        ],
        inverse: [{ ticket_id: "B", relation_type: "builds_on" }],
      }).sort(),
    ).toEqual(["A", "B"]);
  });
});
