import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  buildHandler,
  HandlerInputSchema,
  IronforgeDeprovisionFailedHandlerError,
  IronforgeWorkflowInputError,
} from "./handle-event.js";

const ddbMock = mockClient(docClient);

const ORIGINAL_TABLE = process.env["DYNAMODB_TABLE_NAME"];
beforeAll(() => {
  process.env["DYNAMODB_TABLE_NAME"] = "ironforge-test";
});
afterAll(() => {
  if (ORIGINAL_TABLE === undefined) {
    delete process.env["DYNAMODB_TABLE_NAME"];
  } else {
    process.env["DYNAMODB_TABLE_NAME"] = ORIGINAL_TABLE;
  }
});

beforeEach(() => {
  ddbMock.reset();
});

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const FAILED_AT_MS = new Date("2026-05-04T13:00:00.000Z").getTime();
const FAILED_AT_ISO = "2026-05-04T13:00:00.000Z";

const buildTestHandler = () =>
  buildHandler({ now: () => FAILED_AT_MS });

const conditionFailed = (): Error =>
  new ConditionalCheckFailedException({
    $metadata: {},
    message: "The conditional request failed",
  });

describe("HandlerInputSchema", () => {
  it("accepts {jobId, serviceId} alone (steps + error optional)", () => {
    expect(
      HandlerInputSchema.safeParse({ jobId: JOB_ID, serviceId: SERVICE_ID })
        .success,
    ).toBe(true);
  });

  it("accepts {jobId, serviceId, steps, error}", () => {
    expect(
      HandlerInputSchema.safeParse({
        jobId: JOB_ID,
        serviceId: SERVICE_ID,
        steps: { "deprovision-terraform": { foo: "bar" } },
        error: { Error: "States.TaskFailed", Cause: "stack" },
      }).success,
    ).toBe(true);
  });

  it("rejects non-uuid jobId", () => {
    expect(
      HandlerInputSchema.safeParse({ jobId: "x", serviceId: SERVICE_ID })
        .success,
    ).toBe(false);
  });
});

describe("deprovision-failed — failedStep inference", () => {
  it("State 1 caught → no $.steps yet → failedStep = deprovision-terraform", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const handler = buildTestHandler();

    const result = await handler({ jobId: JOB_ID, serviceId: SERVICE_ID });

    expect(result.failedStep).toBe("deprovision-terraform");
  });

  it("State 2 caught → $.steps.deprovision-terraform present → failedStep = deprovision-external-resources", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const handler = buildTestHandler();

    const result = await handler({
      jobId: JOB_ID,
      serviceId: SERVICE_ID,
      steps: { "deprovision-terraform": {} },
    });

    expect(result.failedStep).toBe("deprovision-external-resources");
  });
});

describe("deprovision-failed — happy path", () => {
  it("transitions Service deprovisioning→failed, Job running→failed, writes 4 DDB updates", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const handler = buildTestHandler();

    const result = await handler({ jobId: JOB_ID, serviceId: SERVICE_ID });

    expect(result).toEqual({
      failedStep: "deprovision-terraform",
      failedAt: FAILED_AT_ISO,
    });

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(4); // JobStep running, Service, Job, JobStep succeeded

    const serviceUpdate = updates[1]!.args[0].input;
    expect(serviceUpdate.ExpressionAttributeValues?.[":from"]).toBe(
      "deprovisioning",
    );
    expect(serviceUpdate.ExpressionAttributeValues?.[":to"]).toBe("failed");
    const serviceVals = Object.values(
      serviceUpdate.ExpressionAttributeValues ?? {},
    );
    expect(serviceVals).toContain("deprovisioning"); // failedWorkflow
    expect(serviceVals).toContain(null); // currentJobId cleared

    const jobUpdate = updates[2]!.args[0].input;
    expect(jobUpdate.ExpressionAttributeValues?.[":from"]).toBe("running");
    expect(jobUpdate.ExpressionAttributeValues?.[":to"]).toBe("failed");

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("does NOT make any Lambda invokes or S3 deletes (no destroy chain re-run)", async () => {
    // Sanity check on the architectural-decision-not-to-re-run-the-chain.
    // No mock setup for LambdaClient or S3Client — if the handler were
    // calling them, the unmocked AWS SDK calls would surface during
    // test runs (and we'd see them in the SFN execution as separate
    // service calls). Only DDB writes here.
    ddbMock.on(UpdateCommand).resolves({});
    const handler = buildTestHandler();

    await handler({
      jobId: JOB_ID,
      serviceId: SERVICE_ID,
      steps: { "deprovision-terraform": {} },
    });

    // Verifies the only AWS surface touched is DynamoDB (UpdateCommand
    // for transitions + JobStep upserts; no GetCommand on happy path).
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(4);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});

describe("deprovision-failed — Service idempotent retry", () => {
  it("Service conditional fails but state is failed → continues", async () => {
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({}) // JobStep running
      .rejectsOnce(conditionFailed()) // Service transition fails
      .resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { status: "failed" } });

    const handler = buildTestHandler();
    const result = await handler({ jobId: JOB_ID, serviceId: SERVICE_ID });

    expect(result.failedAt).toBe(FAILED_AT_ISO);
    // 2 GetCommand calls: transitionStatus internal + our inspectService.
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it("Service in unexpected state (still deprovisioning) → throws", async () => {
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({})
      .rejectsOnce(conditionFailed())
      .resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { status: "deprovisioning" } });

    const handler = buildTestHandler();
    await expect(
      handler({ jobId: JOB_ID, serviceId: SERVICE_ID }),
    ).rejects.toBeInstanceOf(IronforgeDeprovisionFailedHandlerError);
  });
});

describe("deprovision-failed — Job idempotent retry", () => {
  it("Job conditional fails but state is failed → returns", async () => {
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({}) // JobStep running
      .resolvesOnce({}) // Service transition
      .rejectsOnce(conditionFailed()) // Job transition fails
      .resolves({}); // JobStep succeeded
    ddbMock.on(GetCommand).resolves({ Item: { status: "failed" } });

    const handler = buildTestHandler();
    const result = await handler({ jobId: JOB_ID, serviceId: SERVICE_ID });

    expect(result.failedAt).toBe(FAILED_AT_ISO);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it("Job in unexpected state → throws", async () => {
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({})
      .resolvesOnce({})
      .rejectsOnce(conditionFailed())
      .resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { status: "running" } });

    const handler = buildTestHandler();
    await expect(
      handler({ jobId: JOB_ID, serviceId: SERVICE_ID }),
    ).rejects.toBeInstanceOf(IronforgeDeprovisionFailedHandlerError);
  });
});

describe("deprovision-failed — input validation", () => {
  it("throws IronforgeWorkflowInputError on schema mismatch", async () => {
    const handler = buildTestHandler();
    await expect(handler({ not: "valid" })).rejects.toBeInstanceOf(
      IronforgeWorkflowInputError,
    );
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
