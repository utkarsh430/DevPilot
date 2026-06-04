// Test bounds for plan input fields (openingMessage, content).
//
// These tests verify that:
// 1. Long project descriptions (~10,900 chars) can be pasted into the Plan opener
// 2. The new ceiling at 65,536 characters is enforced
// 3. All three plan message schemas (start, send, edit) share the same bound
//
// Schemas are imported from lib/plan/input-schemas.ts (the single source of truth)
// so these tests validate the actual bounds, not a local copy.

import { describe, it, expect } from "vitest";
import {
  StartPlanSessionInput,
  SendPlanMessageInput,
  EditPlanMessageInput,
} from "@/lib/plan/input-schemas";

describe("Plan input bounds", () => {
  describe("StartPlanSessionInput.openingMessage", () => {
    it("accepts a ~10,900 character description (reported failure case)", () => {
      // This is the reported case: operator pastes a long project description
      const longDescription = "x".repeat(10_900);
      const result = StartPlanSessionInput.safeParse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        stackFlavor: "industry",
        stackPreferences: "",
        openingMessage: longDescription,
        teamTier: null,
      });
      expect(result.success).toBe(true);
    });

    it("rejects input longer than 65,536 characters", () => {
      const tooLong = "x".repeat(65_537);
      const result = StartPlanSessionInput.safeParse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        stackFlavor: "industry",
        stackPreferences: "",
        openingMessage: tooLong,
        teamTier: null,
      });
      expect(result.success).toBe(false);
    });

    it("accepts exactly 65,536 characters", () => {
      const maxLength = "x".repeat(65_536);
      const result = StartPlanSessionInput.safeParse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        stackFlavor: "industry",
        stackPreferences: "",
        openingMessage: maxLength,
        teamTier: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("SendPlanMessageInput.content", () => {
    it("accepts a ~10,900 character message", () => {
      const longMessage = "x".repeat(10_900);
      const result = SendPlanMessageInput.safeParse({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        content: longMessage,
      });
      expect(result.success).toBe(true);
    });

    it("rejects input longer than 65,536 characters", () => {
      const tooLong = "x".repeat(65_537);
      const result = SendPlanMessageInput.safeParse({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        content: tooLong,
      });
      expect(result.success).toBe(false);
    });

    it("accepts exactly 65,536 characters", () => {
      const maxLength = "x".repeat(65_536);
      const result = SendPlanMessageInput.safeParse({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        content: maxLength,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("EditPlanMessageInput.content", () => {
    it("accepts a ~10,900 character message", () => {
      const longMessage = "x".repeat(10_900);
      const result = EditPlanMessageInput.safeParse({
        messageId: "550e8400-e29b-41d4-a716-446655440000",
        content: longMessage,
      });
      expect(result.success).toBe(true);
    });

    it("rejects input longer than 65,536 characters", () => {
      const tooLong = "x".repeat(65_537);
      const result = EditPlanMessageInput.safeParse({
        messageId: "550e8400-e29b-41d4-a716-446655440000",
        content: tooLong,
      });
      expect(result.success).toBe(false);
    });

    it("accepts exactly 65,536 characters", () => {
      const maxLength = "x".repeat(65_536);
      const result = EditPlanMessageInput.safeParse({
        messageId: "550e8400-e29b-41d4-a716-446655440000",
        content: maxLength,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("all three schemas share the same bound", () => {
    it("enforces 65,536 consistently across all message inputs", () => {
      const overBound = "x".repeat(65_537);
      const openingResult = StartPlanSessionInput.safeParse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        stackFlavor: "industry",
        stackPreferences: "",
        openingMessage: overBound,
        teamTier: null,
      });
      const sendResult = SendPlanMessageInput.safeParse({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        content: overBound,
      });
      const editResult = EditPlanMessageInput.safeParse({
        messageId: "550e8400-e29b-41d4-a716-446655440000",
        content: overBound,
      });

      expect(openingResult.success).toBe(false);
      expect(sendResult.success).toBe(false);
      expect(editResult.success).toBe(false);
    });
  });
});
