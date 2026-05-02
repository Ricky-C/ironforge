import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildJobStepKeys,
  type StepName,
} from "@ironforge/shared-types";

import { docClient } from "../aws/clients.js";

// JobStep DynamoDB-write helpers consumed by every workflow task Lambda
// per the PR-C.0 § "Per-step JobStep write pattern" contract in
// docs/data-model.md. Three helpers, three transitions:
//
//   upsertJobStepRunning  — first action of every task Lambda.
//                            Creates the row if absent; on retry,
//                            increments `attempts` while preserving
//                            startedAt.
//   upsertJobStepSucceeded — terminal-OK transition. Writes per-step
//                            opaque output. Conditional on status=running
//                            so a stale invocation can't overwrite a
//                            terminal state.
//   upsertJobStepFailed    — terminal-error transition. errorName/
//                            errorMessage MUST be sanitized by the
//                            caller (no AWS resource ARNs, no stack
//                            traces) per CLAUDE.md error discipline.
//
// Service / Job-level transitions (kickoff, finalize, cleanup-on-failure)
// use the more general `transitionStatus` helper (../dynamodb/transition.ts).
// JobStep doesn't go through that helper because its keys differ
// (PK/SK pattern is JOB#<id>/STEP#<name>, not the typical entity META).

type UpsertJobStepRunningParams = {
  tableName: string;
  jobId: string;
  stepName: StepName;
};

// Note on retry-after-terminal: the Running upsert is intentionally NOT
// guarded against status=succeeded/failed. SFN retry on a stub that
// already completed is vanishingly unlikely (stubs return synchronously
// and SFN observes success) and the foundational invariant is "natural
// key upsert is safe." Real Lambdas in PR-C.3+ may tighten this when
// their specific failure modes are characterized; doing so now would be
// premature optimization on stubs.
export const upsertJobStepRunning = async (
  params: UpsertJobStepRunningParams,
): Promise<void> => {
  const keys = buildJobStepKeys({ jobId: params.jobId, stepName: params.stepName });
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: params.tableName,
      Key: keys,
      UpdateExpression: [
        "ADD attempts :one",
        "SET #status = :running",
        ", startedAt = if_not_exists(startedAt, :now)",
        ", updatedAt = :now",
        ", jobId = if_not_exists(jobId, :jobId)",
        ", stepName = if_not_exists(stepName, :stepName)",
      ].join(" "),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":one": 1,
        ":running": "running",
        ":now": now,
        ":jobId": params.jobId,
        ":stepName": params.stepName,
      },
    }),
  );
};

type UpsertJobStepSucceededParams = {
  tableName: string;
  jobId: string;
  stepName: StepName;
  // Per-step opaque output — each step Lambda defines its own shape
  // (e.g. create-repo writes { repoUrl, repoId }). The caller's
  // schema, not the helper's concern.
  output: Record<string, unknown>;
};

// Throws ConditionalCheckFailedException if the row isn't in `running`
// status. Caller logs and converts to a workflow-level failure; SFN's
// state-level Catch handles the workflow control flow.
export const upsertJobStepSucceeded = async (
  params: UpsertJobStepSucceededParams,
): Promise<void> => {
  const keys = buildJobStepKeys({ jobId: params.jobId, stepName: params.stepName });
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: params.tableName,
      Key: keys,
      UpdateExpression:
        "SET #status = :succeeded, completedAt = :now, updatedAt = :now, #output = :output",
      ConditionExpression: "#status = :running",
      ExpressionAttributeNames: {
        "#status": "status",
        // `output` is a DynamoDB reserved word — alias it.
        "#output": "output",
      },
      ExpressionAttributeValues: {
        ":succeeded": "succeeded",
        ":running": "running",
        ":now": now,
        ":output": params.output,
      },
    }),
  );
};

type UpsertJobStepFailedParams = {
  tableName: string;
  jobId: string;
  stepName: StepName;
  // Sanitized error class name (no AWS internal exception names that
  // might leak resource identifiers). Caller normalizes — e.g.
  // ProvisioningError, IronforgeValidationError.
  errorName: string;
  // Sanitized message — no resource ARNs, no stack traces. Plain
  // English fit for an end-user-facing failureReason after future
  // surfacing decisions.
  errorMessage: string;
  // Whether SFN-level Retry should re-attempt. Caller derives from
  // the underlying error's class. This is metadata for operators —
  // the actual retry decision lives on the SFN state's Retry block.
  retryable: boolean;
};

// Throws ConditionalCheckFailedException if the row isn't in `running`
// status (same rationale as Succeeded).
export const upsertJobStepFailed = async (
  params: UpsertJobStepFailedParams,
): Promise<void> => {
  const keys = buildJobStepKeys({ jobId: params.jobId, stepName: params.stepName });
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: params.tableName,
      Key: keys,
      UpdateExpression:
        "SET #status = :failed, failedAt = :now, updatedAt = :now, errorName = :errorName, errorMessage = :errorMessage, retryable = :retryable",
      ConditionExpression: "#status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":failed": "failed",
        ":running": "running",
        ":now": now,
        ":errorName": params.errorName,
        ":errorMessage": params.errorMessage,
        ":retryable": params.retryable,
      },
    }),
  );
};
