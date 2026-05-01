import { describe, expect, it } from "vitest";

import {
  buildIdempotencyKeys,
  buildIdempotencyPK,
  IDEMPOTENCY_SK_META,
  IdempotencyRecordSchema,
} from "./idempotency.js";

const HASH = "a".repeat(64);
const SCOPE_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "2026-04-30T15:20:34.567Z";
const FUTURE_EPOCH = Math.floor(Date.now() / 1000) + 86400;

const baseRecord = {
  hash: HASH,
  result: '{"ok":true,"data":{"id":"abc"}}',
  statusCode: 201,
  scopeId: SCOPE_ID,
  createdAt: TIMESTAMP,
  expiresAt: FUTURE_EPOCH,
};

describe("IdempotencyRecordSchema", () => {
  it("accepts a well-formed record", () => {
    expect(IdempotencyRecordSchema.safeParse(baseRecord).success).toBe(true);
  });

  it("rejects when hash is empty", () => {
    expect(
      IdempotencyRecordSchema.safeParse({ ...baseRecord, hash: "" }).success,
    ).toBe(false);
  });

  it("rejects when statusCode is below 100", () => {
    expect(
      IdempotencyRecordSchema.safeParse({ ...baseRecord, statusCode: 99 }).success,
    ).toBe(false);
  });

  it("rejects when statusCode is above 599", () => {
    expect(
      IdempotencyRecordSchema.safeParse({ ...baseRecord, statusCode: 600 }).success,
    ).toBe(false);
  });

  it("rejects when statusCode is non-integer", () => {
    expect(
      IdempotencyRecordSchema.safeParse({ ...baseRecord, statusCode: 200.5 }).success,
    ).toBe(false);
  });

  it("rejects when expiresAt is non-positive", () => {
    expect(
      IdempotencyRecordSchema.safeParse({ ...baseRecord, expiresAt: 0 }).success,
    ).toBe(false);
  });

  it("rejects when scopeId is not a uuid", () => {
    expect(
      IdempotencyRecordSchema.safeParse({ ...baseRecord, scopeId: "not-a-uuid" }).success,
    ).toBe(false);
  });
});

describe("Idempotency key helpers", () => {
  it("buildIdempotencyPK formats IDEMPOTENCY#<hash>", () => {
    expect(buildIdempotencyPK(HASH)).toBe(`IDEMPOTENCY#${HASH}`);
  });

  it("buildIdempotencyKeys produces the full key set", () => {
    expect(buildIdempotencyKeys(HASH)).toEqual({
      PK: `IDEMPOTENCY#${HASH}`,
      SK: IDEMPOTENCY_SK_META,
    });
  });
});
