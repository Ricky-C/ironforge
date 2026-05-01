import { describe, expect, it } from "vitest";

import { awsIdempotencyToken } from "./idempotency-token.js";

describe("awsIdempotencyToken", () => {
  it("joins parts with a hyphen", () => {
    expect(awsIdempotencyToken("a", "b", "c")).toBe("a-b-c");
  });

  it("is deterministic for the same inputs", () => {
    expect(awsIdempotencyToken("svc-id", "create-repo")).toBe(
      awsIdempotencyToken("svc-id", "create-repo"),
    );
  });

  it("lowercases input", () => {
    expect(awsIdempotencyToken("SvcID", "Step")).toBe("svcid-step");
  });

  it("collapses runs of non-alphanumeric characters to a single hyphen", () => {
    expect(awsIdempotencyToken("a..b//c   d")).toBe("a-b-c-d");
  });

  it("strips leading and trailing non-alphanumeric characters per part", () => {
    expect(awsIdempotencyToken("...alpha...", "...beta...")).toBe("alpha-beta");
  });

  it("preserves existing hyphens", () => {
    expect(awsIdempotencyToken("create-repo", "for-svc")).toBe(
      "create-repo-for-svc",
    );
  });

  it("drops parts that become empty after slug cleaning", () => {
    expect(awsIdempotencyToken("alpha", "...", "beta")).toBe("alpha-beta");
  });

  it("throws when called with no parts", () => {
    expect(() => awsIdempotencyToken()).toThrowError(/at least one part/);
  });

  it("throws when all parts become empty after cleaning", () => {
    expect(() => awsIdempotencyToken("...", "//", "")).toThrowError(
      /became empty/,
    );
  });
});
