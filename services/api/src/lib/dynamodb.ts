import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Module-level singleton. aws-sdk-client-mock intercepts at the SDK
// middleware layer regardless of which client instance the handler
// holds, so this singleton is testable without dependency injection.
//
// Region is resolved from the default credential/config chain. In Lambda
// that's AWS_REGION (set by the runtime); locally it's the standard
// AWS_REGION / AWS_PROFILE / ~/.aws/config resolution.
const baseClient = new DynamoDBClient({});

// DocumentClient applies marshall/unmarshall automatically — handler
// code reads/writes plain JS objects, not DynamoDB AttributeValue
// wrappers. Validation against ServiceSchema (or other Zod schemas)
// runs on the unmarshalled output before consumers trust the data.
export const docClient = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    // Treat undefined as a "don't write this attribute" signal rather
    // than throwing. Keeps Service entity writes ergonomic when state-
    // specific fields (liveUrl, failureReason, etc.) are absent.
    removeUndefinedValues: true,
  },
});

// Table name resolved from Lambda env. Reads happen at request time
// (not import time) so test environments can override via env without
// re-importing the module.
export const getTableName = (): string => {
  const name = process.env["DYNAMODB_TABLE_NAME"];
  if (!name) {
    throw new Error(
      "DYNAMODB_TABLE_NAME env var is not set. Lambda config must populate it.",
    );
  }
  return name;
};
