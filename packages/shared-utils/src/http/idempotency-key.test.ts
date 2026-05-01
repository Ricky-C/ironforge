import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { docClient } from "../aws/clients.js";

import { withIdempotencyKey } from "./idempotency-key.js";

const ddbMock = mockClient(docClient);

const conditionalCheckFailed = (): ConditionalCheckFailedException =>
  new ConditionalCheckFailedException({
    $metadata: {},
    message: "ConditionalCheckFailedException",
  });

const HASH = "a".repeat(64);
const SCOPE_ID = "11111111-1111-4111-8111-111111111111";

const cachedItem = (overrides: Record<string, unknown> = {}) => ({
  PK: `IDEMPOTENCY#${HASH}`,
  SK: "META",
  hash: HASH,
  result: '{"id":"abc"}',
  statusCode: 201,
  scopeId: SCOPE_ID,
  createdAt: "2026-04-30T00:00:00.000Z",
  expiresAt: 9999999999,
  ...overrides,
});

beforeEach(() => {
  ddbMock.reset();
});

describe("withIdempotencyKey", () => {
  it("first call: executes and writes the cache record", async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    const execute = vi
      .fn()
      .mockResolvedValue({ statusCode: 201, body: { id: "abc" } });

    const result = await withIdempotencyKey({
      tableName: "ironforge-test",
      hash: HASH,
      scopeId: SCOPE_ID,
      execute,
    });

    expect(result).toEqual({
      kind: "first",
      statusCode: 201,
      body: { id: "abc" },
    });
    expect(execute).toHaveBeenCalledOnce();

    const putInput = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(putInput.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect((putInput.Item as Record<string, unknown>)["scopeId"]).toBe(SCOPE_ID);
    expect((putInput.Item as Record<string, unknown>)["statusCode"]).toBe(201);
    expect((putInput.Item as Record<string, unknown>)["result"]).toBe(
      '{"id":"abc"}',
    );
  });

  it("replay: returns cached body and skips execute when record already exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: cachedItem() });
    const execute = vi.fn();

    const result = await withIdempotencyKey({
      tableName: "ironforge-test",
      hash: HASH,
      scopeId: SCOPE_ID,
      execute,
    });

    expect(result).toEqual({
      kind: "replay",
      statusCode: 201,
      body: { id: "abc" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("first call uses default ttl of 24h when ttlSeconds is omitted", async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    const before = Math.floor(Date.now() / 1000);

    await withIdempotencyKey({
      tableName: "ironforge-test",
      hash: HASH,
      scopeId: SCOPE_ID,
      execute: () => Promise.resolve({ statusCode: 200, body: {} }),
    });

    const after = Math.floor(Date.now() / 1000);
    const item = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item as
      | Record<string, unknown>
      | undefined;
    const expiresAt = item?.["expiresAt"] as number;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 86400);
    expect(expiresAt).toBeLessThanOrEqual(after + 86400);
  });

  it("first call respects an explicit ttlSeconds", async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    const before = Math.floor(Date.now() / 1000);

    await withIdempotencyKey({
      tableName: "ironforge-test",
      hash: HASH,
      scopeId: SCOPE_ID,
      ttlSeconds: 60,
      execute: () => Promise.resolve({ statusCode: 200, body: {} }),
    });

    const after = Math.floor(Date.now() / 1000);
    const item = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item as
      | Record<string, unknown>
      | undefined;
    const expiresAt = item?.["expiresAt"] as number;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60);
    expect(expiresAt).toBeLessThanOrEqual(after + 60);
  });

  it("scope mismatch on existing record throws (hash-input bug signal)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: cachedItem({ scopeId: "99999999-9999-4999-8999-999999999999" }),
    });

    await expect(
      withIdempotencyKey({
        tableName: "ironforge-test",
        hash: HASH,
        scopeId: SCOPE_ID,
        execute: () => Promise.resolve({ statusCode: 200, body: {} }),
      }),
    ).rejects.toThrowError(/scope mismatch/);
  });

  it("malformed existing record throws", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { PK: `IDEMPOTENCY#${HASH}`, SK: "META", hash: HASH },
    });

    await expect(
      withIdempotencyKey({
        tableName: "ironforge-test",
        hash: HASH,
        scopeId: SCOPE_ID,
        execute: () => Promise.resolve({ statusCode: 200, body: {} }),
      }),
    ).rejects.toThrowError(/schema validation/);
  });

  it("race: conditional Put fails, re-Get returns winner record, replay", async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({}) // initial check — miss
      .resolves({ Item: cachedItem() }); // race fallback
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed());

    const execute = vi
      .fn()
      .mockResolvedValue({ statusCode: 201, body: { id: "loser" } });

    const result = await withIdempotencyKey({
      tableName: "ironforge-test",
      hash: HASH,
      scopeId: SCOPE_ID,
      execute,
    });

    expect(result).toEqual({
      kind: "replay",
      statusCode: 201,
      body: { id: "abc" },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rethrows non-ConditionalCheckFailed Put errors verbatim", async () => {
    ddbMock.on(GetCommand).resolves({});
    const transient = new Error("ProvisionedThroughputExceeded");
    ddbMock.on(PutCommand).rejects(transient);

    await expect(
      withIdempotencyKey({
        tableName: "ironforge-test",
        hash: HASH,
        scopeId: SCOPE_ID,
        execute: () => Promise.resolve({ statusCode: 200, body: {} }),
      }),
    ).rejects.toBe(transient);
  });
});
