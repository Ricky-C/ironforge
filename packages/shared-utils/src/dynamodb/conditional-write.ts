import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { docClient } from "../aws/clients.js";

// Write an item only if its partition key doesn't already exist.
// Standard "create-if-not-exists" idiom for single-table writes — used
// by the workflow when a task Lambda needs to create-or-attach to an
// existing entity (e.g. attaching to a pre-existing GitHub repo).
//
// On conflict, performs a follow-up GetItem so the caller has the
// existing row to act on without a second round-trip in handler code.
// The unmarshalled existing item is returned as
// `Record<string, unknown>` — callers Zod-validate it against the
// appropriate entity schema before trusting the data.
//
// Caller responsibility: `item` must include both `PK` and `SK`. The
// ConditionExpression checks PK absence (DynamoDB conditional checks
// evaluate against any attribute, but the create-if-not-exists idiom
// is canonical on the partition key).

type CreateIfNotExistsParams<T extends Record<string, unknown>> = {
  tableName: string;
  item: T & { PK: string; SK: string };
};

type CreateIfNotExistsResult<T> =
  | { created: true; item: T }
  | { created: false; existing: Record<string, unknown> };

export const createIfNotExists = async <T extends Record<string, unknown>>(
  params: CreateIfNotExistsParams<T>,
): Promise<CreateIfNotExistsResult<T>> => {
  const { tableName, item } = params;

  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "PK" },
      }),
    );
    return { created: true, item: item as T };
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) {
      throw err;
    }

    // Lost the create race — read the existing row so the caller can
    // decide what to do (idempotent retry: treat as success; conflict:
    // surface as 409).
    const existing = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: item.PK, SK: item.SK },
      }),
    );

    if (!existing.Item) {
      // PK was present at Put time but absent at Get time — TTL eviction
      // between attempts is the most plausible cause. Surface rather
      // than retry-loop; caller decides whether to retry.
      throw new Error(
        "createIfNotExists: ConditionalCheckFailed but item not found on follow-up Get",
      );
    }

    return { created: false, existing: existing.Item };
  }
};
