import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildIdempotencyKeys,
  IdempotencyRecordSchema,
  type IdempotencyRecord,
} from "@ironforge/shared-types";

import { docClient } from "../aws/clients.js";

// HTTP-level idempotency. Wrap a mutating handler so client retries of
// the same (Idempotency-Key, body, ownerId) tuple replay the original
// outcome instead of re-executing. Caller is responsible for hashing —
// `hash` is the sha256 of (idempotencyKey + bodyHash + ownerId), so
// upstream layers can choose their canonicalization (header, body
// hashing, scope id derivation).
//
// Lifecycle:
//
//   1. GetItem on (PK = IDEMPOTENCY#<hash>, SK = META).
//   2. Hit + scope match → replay. Hit + scope mismatch → throw
//      (collision across tenants is impossible by construction; if it
//      happens, the hash input is wrong — fail loud).
//   3. Miss → execute handler, then PutItem with attribute_not_exists
//      to detect concurrent creators.
//   4. Concurrent-creator race → re-Get and replay the winner.
//
// `execute()` MAY have side effects. The caller must ensure those side
// effects are themselves idempotent (use createIfNotExists for entity
// writes; deterministic ids for AWS resources). The cache replays the
// FIRST handler's response body for all subsequent retries — including
// retries that lost the cache write race. See feedback memory
// "Two-pattern idempotency in Ironforge" for the layered model.

type WithIdempotencyKeyParams<T> = {
  tableName: string;
  hash: string;
  scopeId: string;
  // TTL for the cache entry, in seconds. Default 24h.
  ttlSeconds?: number;
  execute: () => Promise<{ statusCode: number; body: T }>;
};

export type IdempotencyOutcome<T> =
  | { kind: "first"; statusCode: number; body: T }
  | { kind: "replay"; statusCode: number; body: T };

const stripKeys = (item: Record<string, unknown>): Record<string, unknown> => {
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest;
};

const replayFromRecord = <T>(record: IdempotencyRecord): IdempotencyOutcome<T> => ({
  kind: "replay",
  statusCode: record.statusCode,
  body: JSON.parse(record.result) as T,
});

export const withIdempotencyKey = async <T = unknown>(
  params: WithIdempotencyKeyParams<T>,
): Promise<IdempotencyOutcome<T>> => {
  const { tableName, hash, scopeId } = params;
  const ttlSeconds = params.ttlSeconds ?? 86400;
  const keys = buildIdempotencyKeys(hash);

  // Step 1 — check for an existing record.
  const initial = await docClient.send(
    new GetCommand({ TableName: tableName, Key: keys }),
  );

  if (initial.Item) {
    const parsed = IdempotencyRecordSchema.safeParse(stripKeys(initial.Item));
    if (!parsed.success) {
      throw new Error(
        "withIdempotencyKey: existing record failed schema validation",
      );
    }
    if (parsed.data.scopeId !== scopeId) {
      // Scope mismatch is impossible by construction (scopeId is part
      // of the hash input). If it happens, upstream hashing is wrong —
      // failing loud beats silently bypassing the cache.
      throw new Error(
        "withIdempotencyKey: existing record scope mismatch — hash input bug",
      );
    }
    return replayFromRecord<T>(parsed.data);
  }

  // Step 2 — execute the wrapped handler.
  const result = await params.execute();

  // Step 3 — write the cache record. Conditional on PK absence so a
  // concurrent winner's record isn't overwritten.
  const now = new Date();
  const record: IdempotencyRecord = {
    hash,
    result: JSON.stringify(result.body),
    statusCode: result.statusCode,
    scopeId,
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + ttlSeconds,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: { ...keys, ...record },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return { kind: "first", statusCode: result.statusCode, body: result.body };
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) {
      throw err;
    }

    // Step 4 — race. Re-Get and replay the winner. Both clients then
    // observe the same response body (and the underlying side effect
    // landed exactly once, courtesy of the deterministic-key idempotency
    // the caller's execute() should be using under the hood).
    const winner = await docClient.send(
      new GetCommand({ TableName: tableName, Key: keys }),
    );
    if (!winner.Item) {
      throw new Error(
        "withIdempotencyKey: race fallback failed to read winner record",
      );
    }
    const parsed = IdempotencyRecordSchema.safeParse(stripKeys(winner.Item));
    if (!parsed.success || parsed.data.scopeId !== scopeId) {
      throw new Error(
        "withIdempotencyKey: race fallback record failed validation",
      );
    }
    return replayFromRecord<T>(parsed.data);
  }
};
