import { describe, expect, it } from "vitest";

import { StaticSiteInputsSchema } from "./static-site.js";

describe("StaticSiteInputsSchema", () => {
  it("accepts an empty object (MVP — no per-template inputs)", () => {
    expect(StaticSiteInputsSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown fields (strict mode catches wizard typos)", () => {
    expect(
      StaticSiteInputsSchema.safeParse({ pageTitle: "anything" }).success,
    ).toBe(false);
  });

  it("rejects null", () => {
    expect(StaticSiteInputsSchema.safeParse(null).success).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(StaticSiteInputsSchema.safeParse("string-input").success).toBe(false);
    expect(StaticSiteInputsSchema.safeParse(42).success).toBe(false);
    expect(StaticSiteInputsSchema.safeParse([]).success).toBe(false);
  });
});
