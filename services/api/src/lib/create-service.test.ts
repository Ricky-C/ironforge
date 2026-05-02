import {
  StartExecutionCommand,
  SFNClient,
  ExecutionAlreadyExists,
} from "@aws-sdk/client-sfn";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, sfnClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { computeIdempotencyHash, createService } from "./create-service.js";

const ddbMock = mockClient(docClient);
const sfnMock = mockClient(sfnClient as unknown as SFNClient);

const TABLE = "ironforge-test";
const STATE_MACHINE_ARN =
  "arn:aws:states:us-east-1:000000000000:stateMachine:ironforge-test-provisioning";
const OWNER = "11111111-1111-4111-8111-111111111111";

const validBody = (overrides: Record<string, unknown> = {}) => ({
  name: "my-site",
  templateId: "static-site",
  inputs: {},
  ...overrides,
});

const ORIGINAL_TABLE = process.env["DYNAMODB_TABLE_NAME"];
beforeAll(() => {
  process.env["DYNAMODB_TABLE_NAME"] = TABLE;
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
  sfnMock.reset();
});

describe("createService — happy path", () => {
  it("returns 201 with service + job + executes TWI + StartExecution + transitions", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: `${STATE_MACHINE_ARN.replace(":stateMachine:", ":execution:")}:job-id`,
      startDate: new Date(),
    });

    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: validBody(),
      idempotencyKey: undefined,
    });

    expect(result.kind).toBe("first");
    expect(result.statusCode).toBe(201);

    // TWI was called with both Service and Job
    const twi = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(twi.TransactItems).toHaveLength(2);

    // SFN StartExecution received WorkflowExecutionInput as JSON
    const sfn = sfnMock.commandCalls(StartExecutionCommand)[0]!.args[0].input;
    const sfnInput = JSON.parse(sfn.input as string);
    expect(sfnInput).toMatchObject({
      serviceName: "my-site",
      ownerId: OWNER,
      templateId: "static-site",
    });
    expect(sfn.stateMachineArn).toBe(STATE_MACHINE_ARN);
    // executionName equals jobId for natural idempotency
    expect(sfn.name).toBe(sfnInput.jobId);

    // Two UpdateItem calls: Service kickoff + Job kickoff
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("response body shape is { service, job } with provisioning + running", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: `${STATE_MACHINE_ARN.replace(":stateMachine:", ":execution:")}:eee`,
      startDate: new Date(),
    });

    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: validBody(),
      idempotencyKey: undefined,
    });

    const body = result.body as {
      ok: true;
      data: {
        service: { status: string; currentJobId: string };
        job: { status: string; executionArn: string };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.service.status).toBe("provisioning");
    expect(body.data.service.currentJobId).toBeTruthy();
    expect(body.data.job.status).toBe("running");
    expect(body.data.job.executionArn).toContain(":execution:");
  });
});

describe("createService — validation errors", () => {
  it("returns 400 INVALID_REQUEST for malformed envelope", async () => {
    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: { name: "abc" }, // missing templateId + inputs
      idempotencyKey: undefined,
    });

    expect(result.kind).toBe("validation-error");
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "INVALID_REQUEST",
    );
    // No DDB or SFN calls should have happened
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("returns 400 INVALID_REQUEST for unknown templateId (envelope-level enum reject)", async () => {
    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: validBody({ templateId: "static-site-nextjs" }),
      idempotencyKey: undefined,
    });

    expect(result.kind).toBe("validation-error");
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "INVALID_REQUEST",
    );
  });

  it("returns 400 INVALID_INPUTS when inputs has unknown fields (StaticSiteInputsSchema strict)", async () => {
    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: validBody({ inputs: { pageTitle: "anything" } }),
      idempotencyKey: undefined,
    });

    expect(result.kind).toBe("validation-error");
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "INVALID_INPUTS",
    );
  });
});

describe("createService — name collision", () => {
  it("returns 409 CONFLICT when Query finds an existing same-name service", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          PK: "SERVICE#xxx",
          name: "my-site",
          status: "live",
        },
      ],
    });

    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: validBody(),
      idempotencyKey: undefined,
    });

    expect(result.kind).toBe("conflict");
    expect(result.statusCode).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "CONFLICT",
    );

    // No TWI / SFN calls — short-circuited
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("ignores archived services in the collision check", async () => {
    // Filter expression excludes archived; Query returns an archived service
    // but the FilterExpression strips it, so Items is empty.
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: `${STATE_MACHINE_ARN.replace(":stateMachine:", ":execution:")}:e`,
      startDate: new Date(),
    });

    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: validBody(),
      idempotencyKey: undefined,
    });

    expect(result.statusCode).toBe(201);
    // Query had FilterExpression with status <> archived — verified by call shape
    const queryInput = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(queryInput.FilterExpression).toContain("#status <> :archived");
    expect(queryInput.ExpressionAttributeValues?.[":archived"]).toBe("archived");
  });
});

describe("createService — SFN edge cases", () => {
  it("treats ExecutionAlreadyExists as success (derives ARN deterministically)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).rejects(
      new ExecutionAlreadyExists({ message: "duplicate execution name", $metadata: {} }),
    );

    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: validBody(),
      idempotencyKey: undefined,
    });

    expect(result.statusCode).toBe(201);
    const body = result.body as { data: { job: { executionArn: string } } };
    expect(body.data.job.executionArn).toContain(":execution:");
  });
});

describe("createService — Idempotency-Key", () => {
  it("with idempotency-key + no cached record, executes and writes cache", async () => {
    ddbMock.on(GetCommand).resolves({}); // cache miss
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({}); // cache write
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: `${STATE_MACHINE_ARN.replace(":stateMachine:", ":execution:")}:e`,
      startDate: new Date(),
    });

    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: validBody(),
      idempotencyKey: "abc-123",
    });

    expect(result.kind).toBe("first");
    expect(result.statusCode).toBe(201);

    // Cache PutCommand was issued with PK = IDEMPOTENCY#<hash>
    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const putItem = puts[0]!.args[0].input.Item as Record<string, unknown>;
    expect(typeof putItem["PK"]).toBe("string");
    expect(putItem["PK"]).toMatch(/^IDEMPOTENCY#[0-9a-f]{64}$/);
  });

  it("with idempotency-key + cached record, replays without re-executing", async () => {
    const cachedBody = { ok: true, data: { service: { id: "cached" }, job: {} } };
    ddbMock.on(GetCommand).resolves({
      Item: {
        PK: `IDEMPOTENCY#${"a".repeat(64)}`,
        SK: "META",
        hash: "a".repeat(64),
        result: JSON.stringify(cachedBody),
        statusCode: 201,
        scopeId: OWNER,
        createdAt: "2026-04-30T00:00:00.000Z",
        expiresAt: 9999999999,
      },
    });

    const result = await createService({
      tableName: TABLE,
      stateMachineArn: STATE_MACHINE_ARN,
      ownerId: OWNER,
      body: validBody(),
      idempotencyKey: "abc-123",
    });

    expect(result.kind).toBe("replay");
    expect(result.statusCode).toBe(201);
    expect(result.body).toEqual(cachedBody);

    // No re-execution: no Query, no TWI, no SFN calls.
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });
});

describe("computeIdempotencyHash", () => {
  it("produces deterministic output for the same inputs", () => {
    const a = computeIdempotencyHash({
      idempotencyKey: "k1",
      body: { name: "x" },
      ownerId: OWNER,
    });
    const b = computeIdempotencyHash({
      idempotencyKey: "k1",
      body: { name: "x" },
      ownerId: OWNER,
    });
    expect(a).toBe(b);
  });

  it("differs when the body differs", () => {
    const a = computeIdempotencyHash({
      idempotencyKey: "k1",
      body: { name: "x" },
      ownerId: OWNER,
    });
    const b = computeIdempotencyHash({
      idempotencyKey: "k1",
      body: { name: "y" },
      ownerId: OWNER,
    });
    expect(a).not.toBe(b);
  });

  it("differs when the scope (ownerId) differs", () => {
    const a = computeIdempotencyHash({
      idempotencyKey: "k1",
      body: { name: "x" },
      ownerId: OWNER,
    });
    const b = computeIdempotencyHash({
      idempotencyKey: "k1",
      body: { name: "x" },
      ownerId: "22222222-2222-4222-8222-222222222222",
    });
    expect(a).not.toBe(b);
  });
});
