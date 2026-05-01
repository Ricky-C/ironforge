import { describe, expect, it } from "vitest";

import { ServiceListCursorSchema } from "./pagination.js";

const VALID_CURSOR = {
  PK: "SERVICE#22222222-2222-4222-8222-222222222222",
  SK: "META",
  GSI1PK: "OWNER#11111111-1111-4111-8111-111111111111",
  GSI1SK: "SERVICE#2026-04-30T15:20:34.567Z#22222222-2222-4222-8222-222222222222",
};

describe("ServiceListCursorSchema", () => {
  it("accepts a well-formed cursor", () => {
    expect(ServiceListCursorSchema.safeParse(VALID_CURSOR).success).toBe(true);
  });

  it.each([
    ["JOB#abc", "PK", "wrong PK prefix"],
    ["abc", "PK", "PK with no prefix"],
  ])("rejects when PK is %s (%s)", (badValue) => {
    expect(
      ServiceListCursorSchema.safeParse({ ...VALID_CURSOR, PK: badValue }).success,
    ).toBe(false);
  });

  it("rejects when SK is not literal META", () => {
    expect(
      ServiceListCursorSchema.safeParse({ ...VALID_CURSOR, SK: "OTHER" }).success,
    ).toBe(false);
  });

  it("rejects when GSI1PK does not start with OWNER#", () => {
    expect(
      ServiceListCursorSchema.safeParse({ ...VALID_CURSOR, GSI1PK: "SERVICE#abc" }).success,
    ).toBe(false);
  });

  it("rejects when GSI1SK does not start with SERVICE#", () => {
    expect(
      ServiceListCursorSchema.safeParse({ ...VALID_CURSOR, GSI1SK: "JOB#abc" }).success,
    ).toBe(false);
  });

  it("rejects when fields are missing", () => {
    const partial = { ...VALID_CURSOR } as Partial<typeof VALID_CURSOR>;
    delete partial.GSI1SK;
    expect(ServiceListCursorSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(ServiceListCursorSchema.safeParse("not an object").success).toBe(false);
    expect(ServiceListCursorSchema.safeParse(null).success).toBe(false);
    expect(ServiceListCursorSchema.safeParse(42).success).toBe(false);
  });
});
