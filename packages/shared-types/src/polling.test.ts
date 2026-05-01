import { describe, expect, it } from "vitest";

import { PollResultSchema } from "./polling.js";

describe("PollResultSchema", () => {
  it("accepts in_progress", () => {
    expect(PollResultSchema.safeParse({ status: "in_progress" }).success).toBe(true);
  });

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
    expect(PollResultSchema.safeParse({ status: "succeeded" }).success).toBe(false);
  });

  it("accepts failed with error string", () => {
    expect(
      PollResultSchema.safeParse({ status: "failed", error: "timed out" }).success,
    ).toBe(true);
  });

  it("rejects failed with empty error", () => {
    expect(
      PollResultSchema.safeParse({ status: "failed", error: "" }).success,
    ).toBe(false);
  });

  it("rejects unknown status", () => {
    expect(PollResultSchema.safeParse({ status: "ghost" }).success).toBe(false);
  });
});
