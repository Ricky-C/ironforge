import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { docClient } from "../aws/clients.js";

import {
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
} from "./job-step.js";

const ddbMock = mockClient(docClient);

const conditionalCheckFailed = (): ConditionalCheckFailedException =>
  new ConditionalCheckFailedException({
    $metadata: {},
    message: "ConditionalCheckFailedException",
  });

const TABLE = "ironforge-test";
const JOB_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  ddbMock.reset();
});

describe("upsertJobStepRunning", () => {
  it("issues an UpdateItem with the JobStep PK/SK", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await upsertJobStepRunning({
      tableName: TABLE,
      jobId: JOB_ID,
      stepName: "validate-inputs",
    });

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.TableName).toBe(TABLE);
    expect(input.Key).toEqual({
      PK: `JOB#${JOB_ID}`,
      SK: "STEP#validate-inputs",
    });
  });

  it("uses ADD on attempts and SET with if_not_exists guards on initial fields", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await upsertJobStepRunning({
      tableName: TABLE,
      jobId: JOB_ID,
      stepName: "create-repo",
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toContain("ADD attempts :one");
    expect(input.UpdateExpression).toContain("#status = :running");
    expect(input.UpdateExpression).toContain(
      "startedAt = if_not_exists(startedAt, :now)",
    );
    expect(input.UpdateExpression).toContain(
      "jobId = if_not_exists(jobId, :jobId)",
    );
    expect(input.UpdateExpression).toContain(
      "stepName = if_not_exists(stepName, :stepName)",
    );
  });

  it("does not include a ConditionExpression (idempotent natural-key upsert)", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await upsertJobStepRunning({
      tableName: TABLE,
      jobId: JOB_ID,
      stepName: "finalize",
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBeUndefined();
  });

  it("rethrows non-ConditionalCheckFailed errors", async () => {
    const transient = new Error("ProvisionedThroughputExceeded");
    ddbMock.on(UpdateCommand).rejects(transient);

    await expect(
      upsertJobStepRunning({
        tableName: TABLE,
        jobId: JOB_ID,
        stepName: "finalize",
      }),
    ).rejects.toBe(transient);
  });
});

describe("upsertJobStepSucceeded", () => {
  it("transitions running → succeeded with the supplied output", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await upsertJobStepSucceeded({
      tableName: TABLE,
      jobId: JOB_ID,
      stepName: "create-repo",
      output: { repoUrl: "https://github.com/ironforge-svc/foo", repoId: 42 },
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe("#status = :running");
    expect(input.UpdateExpression).toContain("#status = :succeeded");
    expect(input.UpdateExpression).toContain("completedAt = :now");
    expect(input.UpdateExpression).toContain("#output = :output");
    expect(input.ExpressionAttributeValues?.[":output"]).toEqual({
      repoUrl: "https://github.com/ironforge-svc/foo",
      repoId: 42,
    });
    // `output` is a DynamoDB reserved word; verify the alias is in place.
    expect(input.ExpressionAttributeNames?.["#output"]).toBe("output");
  });

  it("accepts an empty output object", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await expect(
      upsertJobStepSucceeded({
        tableName: TABLE,
        jobId: JOB_ID,
        stepName: "finalize",
        output: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates ConditionalCheckFailedException when row isn't in running status", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());

    await expect(
      upsertJobStepSucceeded({
        tableName: TABLE,
        jobId: JOB_ID,
        stepName: "finalize",
        output: {},
      }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });
});

describe("upsertJobStepFailed", () => {
  it("transitions running → failed with sanitized error metadata", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await upsertJobStepFailed({
      tableName: TABLE,
      jobId: JOB_ID,
      stepName: "validate-inputs",
      errorName: "IronforgeValidationError",
      errorMessage: "input.framework is required",
      retryable: false,
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe("#status = :running");
    expect(input.UpdateExpression).toContain("#status = :failed");
    expect(input.UpdateExpression).toContain("failedAt = :now");
    expect(input.UpdateExpression).toContain("errorName = :errorName");
    expect(input.UpdateExpression).toContain("errorMessage = :errorMessage");
    expect(input.UpdateExpression).toContain("retryable = :retryable");
    expect(input.ExpressionAttributeValues?.[":errorName"]).toBe(
      "IronforgeValidationError",
    );
    expect(input.ExpressionAttributeValues?.[":errorMessage"]).toBe(
      "input.framework is required",
    );
    expect(input.ExpressionAttributeValues?.[":retryable"]).toBe(false);
  });

  it("accepts retryable=true (transient AWS errors)", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await upsertJobStepFailed({
      tableName: TABLE,
      jobId: JOB_ID,
      stepName: "create-repo",
      errorName: "Lambda.ServiceException",
      errorMessage: "service unavailable",
      retryable: true,
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues?.[":retryable"]).toBe(true);
  });

  it("propagates ConditionalCheckFailedException when row isn't in running status", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());

    await expect(
      upsertJobStepFailed({
        tableName: TABLE,
        jobId: JOB_ID,
        stepName: "create-repo",
        errorName: "X",
        errorMessage: "y",
        retryable: false,
      }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });
});
