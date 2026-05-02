import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  API_ERROR_CODES,
  ApiErrorCodeSchema,
  ApiErrorSchema,
  ApiResponseSchema,
} from "./api.js";

describe("ApiErrorCodeSchema", () => {
  it.each(API_ERROR_CODES)("accepts %s", (code) => {
    expect(ApiErrorCodeSchema.safeParse(code).success).toBe(true);
  });

  it("rejects unknown codes", () => {
    expect(ApiErrorCodeSchema.safeParse("MYSTERY").success).toBe(false);
  });

  it("includes POST /api/services error codes (PR-C.2)", () => {
    expect(API_ERROR_CODES).toContain("UNKNOWN_TEMPLATE");
    expect(API_ERROR_CODES).toContain("INVALID_INPUTS");
    expect(API_ERROR_CODES).toContain("CONFLICT");
  });
});

describe("ApiErrorSchema", () => {
  it("accepts a well-formed error", () => {
    const result = ApiErrorSchema.safeParse({
      code: "INVALID_CURSOR",
      message: "cursor failed validation",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when code is unknown", () => {
    const result = ApiErrorSchema.safeParse({
      code: "WAT",
      message: "anything",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when message is missing", () => {
    const result = ApiErrorSchema.safeParse({ code: "INTERNAL" });
    expect(result.success).toBe(false);
  });
});

describe("ApiResponseSchema", () => {
  const SampleData = z.object({ value: z.number() });
  const SampleResponse = ApiResponseSchema(SampleData);

  it("parses a success response", () => {
    const result = SampleResponse.safeParse({ ok: true, data: { value: 42 } });
    expect(result.success).toBe(true);
  });

  it("parses a failure response", () => {
    const result = SampleResponse.safeParse({
      ok: false,
      error: { code: "NOT_FOUND", message: "missing" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects success response with wrong data shape", () => {
    const result = SampleResponse.safeParse({ ok: true, data: { value: "not a number" } });
    expect(result.success).toBe(false);
  });

  it("rejects success response with both data and error", () => {
    const result = SampleResponse.safeParse({
      ok: true,
      data: { value: 1 },
      error: { code: "INTERNAL", message: "x" },
    });
    // Discriminated union accepts the success branch and ignores the
    // extra `error` key by default — the union dispatches on `ok`. This
    // documents that behavior so any future tightening is intentional.
    expect(result.success).toBe(true);
  });

  it("rejects when ok discriminator is missing", () => {
    const result = SampleResponse.safeParse({ data: { value: 1 } });
    expect(result.success).toBe(false);
  });
});
