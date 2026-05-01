import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { docClient } from "../aws/clients.js";

// Atomically transition an entity's status field from one value to
// another, applying any companion attribute updates in the same
// UpdateItem so the row is never observed mid-transition. Used by every
// workflow task Lambda to move Service.status / Job.status forward in
// the state machine without races.
//
// On condition fail, performs a follow-up GetItem to read the actual
// current status — the caller decides whether the failure is expected
// (concurrent retry of the same step → status already at toStatus is
// fine) or surprising (status drifted from the from value because
// something else moved it → real conflict).

type TransitionStatusParams<TKey extends Record<string, unknown>> = {
  tableName: string;
  key: TKey;
  fromStatus: string;
  toStatus: string;
  // Additional attributes to SET in the same UpdateItem so observers
  // can never see "status changed but companion fields not yet". For
  // example, a Service moving pending → provisioning sets status AND
  // currentJobId in the same call.
  additionalUpdates?: Record<string, unknown>;
  // Default attribute name for the status field. Override if an entity
  // stores status under a different name (e.g. "state").
  statusAttributeName?: string;
};

type TransitionStatusResult =
  | { transitioned: true }
  | { transitioned: false; currentStatus: string | null };

export const transitionStatus = async <TKey extends Record<string, unknown>>(
  params: TransitionStatusParams<TKey>,
): Promise<TransitionStatusResult> => {
  const statusAttr = params.statusAttributeName ?? "status";
  const additional = params.additionalUpdates ?? {};

  // Build the SET expression, ExpressionAttributeNames, and
  // ExpressionAttributeValues. Names indirected through `#status` and
  // `#u<i>` so reserved words and attribute names with special
  // characters don't break the expression parser.
  const setClauses: string[] = ["#status = :to"];
  const exprNames: Record<string, string> = { "#status": statusAttr };
  const exprValues: Record<string, unknown> = {
    ":from": params.fromStatus,
    ":to": params.toStatus,
  };

  let i = 0;
  for (const [k, v] of Object.entries(additional)) {
    const nameKey = `#u${i}`;
    const valKey = `:u${i}`;
    setClauses.push(`${nameKey} = ${valKey}`);
    exprNames[nameKey] = k;
    exprValues[valKey] = v;
    i++;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: params.tableName,
        Key: params.key,
        UpdateExpression: "SET " + setClauses.join(", "),
        ConditionExpression: "#status = :from",
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
      }),
    );
    return { transitioned: true };
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) {
      throw err;
    }

    const existing = await docClient.send(
      new GetCommand({
        TableName: params.tableName,
        Key: params.key,
      }),
    );
    const current = existing.Item?.[statusAttr];
    const currentStatus = typeof current === "string" ? current : null;
    return { transitioned: false, currentStatus };
  }
};
