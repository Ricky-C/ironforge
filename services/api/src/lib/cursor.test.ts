import { describe, expect, it } from "vitest";

import { decodeServiceListCursor, encodeServiceListCursor } from "./cursor.js";

const SAMPLE_CURSOR = {
  PK: "SERVICE#22222222-2222-4222-8222-222222222222",
  SK: "META" as const,
  GSI1PK: "OWNER#11111111-1111-4111-8111-111111111111",
  GSI1SK: "SERVICE#2026-04-30T15:20:34.567Z#22222222-2222-4222-8222-222222222222",
};

describe("cursor encode/decode round-trip", () => {
  it("encodes and decodes a well-formed cursor losslessly", () => {
    const encoded = encodeServiceListCursor(SAMPLE_CURSOR);
    expect(decodeServiceListCursor(encoded)).toEqual(SAMPLE_CURSOR);
  });

  it("encoded cursor is URL-safe (no +, /, or = characters)", () => {
    // base64url replaces + with -, / with _, and strips trailing padding.
    // A cursor passed through `?cursor=...` shouldn't need URL encoding.
    const encoded = encodeServiceListCursor(SAMPLE_CURSOR);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("encoded cursor is non-empty for a non-empty input", () => {
    expect(encodeServiceListCursor(SAMPLE_CURSOR).length).toBeGreaterThan(0);
  });
});

describe("decodeServiceListCursor — failure modes", () => {
  it("returns null for malformed base64url input", () => {
    // base64url decode is permissive (pads as needed), so a truly-invalid
    // input is one that decodes to bytes that don't form valid UTF-8 OR
    // to a byte stream JSON.parse rejects. The pipeline catches both.
    expect(decodeServiceListCursor("!!!not base64!!!")).toBeNull();
  });

  it("returns null for valid base64url but non-JSON content", () => {
    const encoded = Buffer.from("not json at all", "utf8").toString("base64url");
    expect(decodeServiceListCursor(encoded)).toBeNull();
  });

  it("returns null for valid JSON but wrong shape (missing fields)", () => {
    const encoded = Buffer.from(JSON.stringify({ PK: "SERVICE#abc" }), "utf8").toString(
      "base64url",
    );
    expect(decodeServiceListCursor(encoded)).toBeNull();
  });

  it("returns null for valid JSON but wrong PK prefix", () => {
    const encoded = Buffer.from(
      JSON.stringify({ ...SAMPLE_CURSOR, PK: "JOB#abc" }),
      "utf8",
    ).toString("base64url");
    expect(decodeServiceListCursor(encoded)).toBeNull();
  });

  it("returns null for valid JSON but SK literal mismatch", () => {
    const encoded = Buffer.from(
      JSON.stringify({ ...SAMPLE_CURSOR, SK: "OTHER" }),
      "utf8",
    ).toString("base64url");
    expect(decodeServiceListCursor(encoded)).toBeNull();
  });

  it("returns null for valid JSON but GSI1PK prefix mismatch", () => {
    const encoded = Buffer.from(
      JSON.stringify({ ...SAMPLE_CURSOR, GSI1PK: "SERVICE#abc" }),
      "utf8",
    ).toString("base64url");
    expect(decodeServiceListCursor(encoded)).toBeNull();
  });

  it("returns null for valid JSON but GSI1SK prefix mismatch", () => {
    const encoded = Buffer.from(
      JSON.stringify({ ...SAMPLE_CURSOR, GSI1SK: "JOB#abc" }),
      "utf8",
    ).toString("base64url");
    expect(decodeServiceListCursor(encoded)).toBeNull();
  });

  it("returns null for non-object JSON (string)", () => {
    const encoded = Buffer.from(JSON.stringify("just a string"), "utf8").toString(
      "base64url",
    );
    expect(decodeServiceListCursor(encoded)).toBeNull();
  });

  it("returns null for empty string input", () => {
    // Empty string decodes to empty buffer → empty string → JSON.parse
    // fails → null.
    expect(decodeServiceListCursor("")).toBeNull();
  });
});
