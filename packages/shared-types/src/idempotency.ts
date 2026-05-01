import { z } from "zod";

// HTTP-level idempotency record. Stores the cached response for a
// (idempotencyKey, body, scopeId) tuple so client retries of mutating
// POST endpoints replay the original outcome rather than re-executing.
// Not used for Step Functions task idempotency — that uses deterministic
// IDs derived from the execution name. See feedback memory
// "Two-pattern idempotency in Ironforge" for the layer split, and
// CLAUDE.md § API Conventions § Idempotency for the HTTP contract.
//
// Lookup key: PK = IDEMPOTENCY#<hash>, SK = META.
//   hash = sha256(idempotencyKey + bodyHash + scopeId)
// scopeId is the Cognito sub of the requester — collisions across
// tenants are impossible by construction.
//
// Records are auto-evicted by DynamoDB TTL on `expiresAt` (Unix epoch
// seconds). Default retention is 24 h; the API's withIdempotencyKey
// helper sets the value at write time.

const IsoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "must be ISO 8601 UTC with milliseconds (e.g. 2026-04-30T15:20:34.567Z)",
  );

export const IdempotencyRecordSchema = z.object({
  // hash duplicated as a non-key attribute for query convenience
  // (key-only projections wouldn't include it; we want it in unmarshalled
  // reads without an explicit ProjectionExpression).
  hash: z.string().min(1),
  // Serialized response body. JSON.stringify of the original handler's
  // response data; replayed verbatim on idempotent re-requests.
  result: z.string(),
  // HTTP status code to replay (e.g. 201 on first call → 200 on replay
  // is the caller's choice; the field stores whatever the caller decided).
  statusCode: z.number().int().min(100).max(599),
  scopeId: z.string().uuid(),
  createdAt: IsoTimestampSchema,
  // DynamoDB TTL attribute. Unix epoch seconds (NOT milliseconds — TTL
  // requires seconds). DynamoDB evicts within 48 h of expiry, typically
  // much sooner; do NOT rely on this for security-sensitive eviction.
  expiresAt: z.number().int().positive(),
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

export type IdempotencyRecordItemKeys = {
  PK: `IDEMPOTENCY#${string}`;
  SK: "META";
};
export type IdempotencyRecordItem = IdempotencyRecord & IdempotencyRecordItemKeys;

export const buildIdempotencyPK = (hash: string): `IDEMPOTENCY#${string}` =>
  `IDEMPOTENCY#${hash}`;
export const IDEMPOTENCY_SK_META = "META" as const;

export const buildIdempotencyKeys = (hash: string): IdempotencyRecordItemKeys => ({
  PK: buildIdempotencyPK(hash),
  SK: IDEMPOTENCY_SK_META,
});
