import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SFNClient } from "@aws-sdk/client-sfn";

// Module-level singletons. aws-sdk-client-mock intercepts at the SDK
// middleware layer regardless of which client instance the handler
// holds, so these singletons are testable without dependency injection.
//
// Region is resolved from the default credential/config chain. In Lambda
// that's AWS_REGION (set by the runtime); locally it's the standard
// AWS_REGION / AWS_PROFILE / ~/.aws/config resolution.
const baseClient = new DynamoDBClient({});

// DocumentClient applies marshall/unmarshall automatically — handler
// code reads/writes plain JS objects, not DynamoDB AttributeValue
// wrappers. Validation against Zod schemas runs on the unmarshalled
// output before consumers trust the data.
export const docClient = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    // Treat undefined as a "don't write this attribute" signal rather
    // than throwing. Keeps entity writes ergonomic when state-specific
    // fields (liveUrl, failureReason, etc.) are absent.
    removeUndefinedValues: true,
  },
});

// Step Functions client. Used by the POST /api/services handler to
// call StartExecution on the provisioning state machine. Workflow
// Lambdas don't currently use SFN directly (they receive input from
// SFN but don't invoke it), but exporting a singleton here keeps the
// SDK-client surface in one place.
export const sfnClient = new SFNClient({});

// Secrets Manager client. Used by the github-app helper to fetch the
// GitHub App PEM at cold start. Singleton for connection-reuse per AWS
// SDK guidance; aws-sdk-client-mock intercepts at the middleware layer
// so tests don't need DI.
export const secretsManagerClient = new SecretsManagerClient({});

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

// State machine ARN resolved from Lambda env. POST /api/services calls
// StartExecution against this ARN. Workflow Lambdas don't need this —
// they live INSIDE an execution and read $$.Execution if anything.
export const getStateMachineArn = (): string => {
  const arn = process.env["PROVISIONING_STATE_MACHINE_ARN"];
  if (!arn) {
    throw new Error(
      "PROVISIONING_STATE_MACHINE_ARN env var is not set. Lambda config must populate it.",
    );
  }
  return arn;
};
