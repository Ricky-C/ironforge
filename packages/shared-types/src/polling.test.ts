import { describe, expect, it } from "vitest";

import { PollResultSchema } from "./polling.js";

describe("PollResultSchema", () => {
  describe("in_progress", () => {
    it("accepts in_progress with nextWaitSeconds and no pollState", () => {
      expect(
        PollResultSchema.safeParse({ status: "in_progress", nextWaitSeconds: 30 })
          .success,
      ).toBe(true);
    });

    it("accepts in_progress with pollState carry-forward bag", () => {
      expect(
        PollResultSchema.safeParse({
          status: "in_progress",
          nextWaitSeconds: 60,
          pollState: { startedAt: "2026-05-03T12:00:00.000Z", pollAttempt: 3 },
        }).success,
      ).toBe(true);
    });

    it("rejects in_progress missing nextWaitSeconds", () => {
      expect(
        PollResultSchema.safeParse({ status: "in_progress" }).success,
      ).toBe(false);
    });

    it("rejects nextWaitSeconds below 1", () => {
      expect(
        PollResultSchema.safeParse({ status: "in_progress", nextWaitSeconds: 0 })
          .success,
      ).toBe(false);
    });

    it("rejects nextWaitSeconds above the 120 ceiling", () => {
      expect(
        PollResultSchema.safeParse({ status: "in_progress", nextWaitSeconds: 121 })
          .success,
      ).toBe(false);
    });

    it("rejects fractional nextWaitSeconds", () => {
      expect(
        PollResultSchema.safeParse({ status: "in_progress", nextWaitSeconds: 1.5 })
          .success,
      ).toBe(false);
    });
  });

  describe("succeeded", () => {
    it("accepts succeeded with arbitrary result", () => {
      const result = PollResultSchema.safeParse({
        status: "succeeded",
        result: { distributionId: "E1234567890" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts succeeded with primitive result", () => {
      expect(
        PollResultSchema.safeParse({ status: "succeeded", result: 42 }).success,
      ).toBe(true);
    });

    it("rejects succeeded missing the result field", () => {
      expect(PollResultSchema.safeParse({ status: "succeeded" }).success).toBe(
        false,
      );
    });
  });

  describe("failed", () => {
    it("accepts failed with error string", () => {
      expect(
        PollResultSchema.safeParse({ status: "failed", error: "timed out" })
          .success,
      ).toBe(true);
    });

    it("rejects failed with empty error", () => {
      expect(
        PollResultSchema.safeParse({ status: "failed", error: "" }).success,
      ).toBe(false);
    });
  });

  it("rejects unknown status", () => {
    expect(PollResultSchema.safeParse({ status: "ghost" }).success).toBe(false);
  });
});
