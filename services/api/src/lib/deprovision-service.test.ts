import {
  ExecutionAlreadyExists,
  SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, sfnClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deprovisionService } from "./deprovision-service.js";

const ddbMock = mockClient(docClient);
const sfnMock = mockClient(sfnClient as unknown as SFNClient);

const TABLE = "ironforge-test";
const DEPROVISION_ARN =
  "arn:aws:states:us-east-1:000000000000:stateMachine:ironforge-test-deprovisioning";
const OWNER = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999999";
const TIMESTAMP = "2026-04-30T15:20:34.567Z";

const baseService = (overrides: Record<string, unknown> = {}) => ({
  PK: `SERVICE#${SERVICE_ID}`,
  SK: "META",
  GSI1PK: `OWNER#${OWNER}`,
  GSI1SK: `SERVICE#${TIMESTAMP}#${SERVICE_ID}`,
  id: SERVICE_ID,
  name: "my-site",
  ownerId: OWNER,
  templateId: "static-site",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  inputs: {},
  currentJobId: null,
  status: "live",
  liveUrl: "https://my-site.ironforge.rickycaballero.com",
  provisionedAt: TIMESTAMP,
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

const callDeprovision = () =>
  deprovisionService({
    tableName: TABLE,
    deprovisioningStateMachineArn: DEPROVISION_ARN,
    ownerId: OWNER,
    serviceId: SERVICE_ID,
  });

// ===========================================================================
// Status routing — kickoff paths (live, failed)
// ===========================================================================

describe("deprovisionService — kickoff from live", () => {
  it("returns 202 with service + job, executes TWI + StartExecution + transition", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseService() });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: `${DEPROVISION_ARN.replace(":stateMachine:", ":execution:")}:job-1`,
      startDate: new Date(),
    });

    const result = await callDeprovision();

    expect(result.kind).toBe("kickoff");
    expect(result.statusCode).toBe(202);

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    const twi = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(twi.TransactItems).toHaveLength(2); // Job Put + Service Update

    // SFN target = deprovisioning state machine ARN.
    const sfn = sfnMock.commandCalls(StartExecutionCommand)[0]!.args[0].input;
    expect(sfn.stateMachineArn).toBe(DEPROVISION_ARN);
    // executionName = jobId for natural idempotency.
    const sfnInput = JSON.parse(sfn.input as string);
    expect(sfn.name).toBe(sfnInput.jobId);
    expect(sfnInput).toMatchObject({
      serviceId: SERVICE_ID,
      serviceName: "my-site",
      ownerId: OWNER,
      templateId: "static-site",
    });

    // One UpdateItem after the TWI: Job queued -> running.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("response body has service.status=deprovisioning + job.status=running", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseService() });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: `${DEPROVISION_ARN.replace(":stateMachine:", ":execution:")}:job-2`,
      startDate: new Date(),
    });

    const result = await callDeprovision();

    type ResponseBody = {
      ok: true;
      data: {
        service: { status: string; jobId: string; currentJobId: string };
        job: { status: string; executionArn: string; currentStep: string };
      };
    };
    const body = result.body as ResponseBody;
    expect(body.ok).toBe(true);
    expect(body.data.service.status).toBe("deprovisioning");
    expect(body.data.service.jobId).toBe(body.data.service.currentJobId);
    expect(body.data.job.status).toBe("running");
    expect(body.data.job.currentStep).toBe("deprovision-terraform");
    expect(body.data.job.executionArn).toContain(":execution:");
  });

  it("Service kickoff Update writes BOTH currentJobId and jobId in same expression", async () => {
    // Mirrors the regression guard from create-service.test.ts post-PR-5a.
    // Service kickoff transition lives inside the TransactWriteCommand
    // here (not a standalone UpdateCommand), so inspect the Update item
    // shape inside TransactItems.
    ddbMock.on(GetCommand).resolves({ Item: baseService() });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: `${DEPROVISION_ARN.replace(":stateMachine:", ":execution:")}:job-3`,
      startDate: new Date(),
    });

    await callDeprovision();

    const twi = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    const serviceUpdate = twi.TransactItems?.[1]?.Update;
    expect(serviceUpdate?.UpdateExpression).toContain("currentJobId = :jobId");
    expect(serviceUpdate?.UpdateExpression).toContain("jobId = :jobId");
    expect(serviceUpdate?.ExpressionAttributeValues?.[":deprovisioning"]).toBe(
      "deprovisioning",
    );
    // Status guard accepts BOTH live AND failed.
    expect(serviceUpdate?.ConditionExpression).toContain(":live");
    expect(serviceUpdate?.ConditionExpression).toContain(":failed");
  });

  it("treats ExecutionAlreadyExists as success (deterministic ARN)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseService() });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).rejects(
      new ExecutionAlreadyExists({
        $metadata: {},
        message: "already exists",
      }),
    );

    const result = await callDeprovision();

    expect(result.statusCode).toBe(202);
    type ResponseBody = {
      ok: true;
      data: { job: { executionArn: string } };
    };
    const body = result.body as ResponseBody;
    expect(body.data.job.executionArn).toContain(":execution:");
  });
});

describe("deprovisionService — kickoff from failed", () => {
  it("transitions failed -> deprovisioning (status guard accepts both)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: baseService({
        status: "failed",
        failureReason: "ACM cert validation timeout",
        failedAt: TIMESTAMP,
        failedWorkflow: "provisioning",
        liveUrl: undefined,
        provisionedAt: undefined,
      }),
    });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({
      executionArn: `${DEPROVISION_ARN.replace(":stateMachine:", ":execution:")}:job-4`,
      startDate: new Date(),
    });

    const result = await callDeprovision();

    expect(result.kind).toBe("kickoff");
    expect(result.statusCode).toBe(202);
  });
});

// ===========================================================================
// Status routing — in-flight (provisioning rejection)
// ===========================================================================

describe("deprovisionService — 409 SERVICE_IN_FLIGHT during pending/provisioning", () => {
  it("returns 409 with code=SERVICE_IN_FLIGHT + currentState=provisioning", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: baseService({
        status: "provisioning",
        jobId: "33333333-3333-4333-8333-333333333333",
        currentJobId: "33333333-3333-4333-8333-333333333333",
        liveUrl: undefined,
        provisionedAt: undefined,
      }),
    });

    const result = await callDeprovision();

    expect(result.kind).toBe("in-flight-rejection");
    expect(result.statusCode).toBe(409);
    type FailureBody = { ok: false; error: { code: string; currentState: string } };
    const body = result.body as FailureBody;
    expect(body.error.code).toBe("SERVICE_IN_FLIGHT");
    expect(body.error.currentState).toBe("provisioning");

    // No DDB writes, no SFN execution.
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("returns 409 SERVICE_IN_FLIGHT for status=pending", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: baseService({
        status: "pending",
        liveUrl: undefined,
        provisionedAt: undefined,
      }),
    });

    const result = await callDeprovision();

    expect(result.kind).toBe("in-flight-rejection");
    expect(result.statusCode).toBe(409);
    type FailureBody = { ok: false; error: { currentState: string } };
    expect((result.body as FailureBody).error.currentState).toBe("pending");
  });
});

// ===========================================================================
// Status routing — idempotent re-DELETE during deprovisioning
// ===========================================================================

describe("deprovisionService — idempotent re-DELETE during deprovisioning", () => {
  const IN_FLIGHT_JOB_ID = "44444444-4444-4444-8444-444444444444";

  it("returns 202 with the existing in-flight Job (no kickoff)", async () => {
    ddbMock.on(GetCommand).callsFakeOnce(() => ({
      // First GET: the Service in deprovisioning state.
      Item: baseService({
        status: "deprovisioning",
        jobId: IN_FLIGHT_JOB_ID,
        currentJobId: IN_FLIGHT_JOB_ID,
        liveUrl: undefined,
        provisionedAt: undefined,
      }),
    })).callsFake(() => ({
      // Second GET: the Job entity by jobId.
      Item: {
        id: IN_FLIGHT_JOB_ID,
        serviceId: SERVICE_ID,
        ownerId: OWNER,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        startedAt: TIMESTAMP,
        executionArn: `${DEPROVISION_ARN.replace(":stateMachine:", ":execution:")}:${IN_FLIGHT_JOB_ID}`,
        currentStep: "deprovision-terraform",
        status: "running",
      },
    }));

    const result = await callDeprovision();

    expect(result.kind).toBe("in-flight-existing");
    expect(result.statusCode).toBe(202);

    // No new TWI, no new SFN execution.
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);

    type ResponseBody = {
      ok: true;
      data: { job: { id: string; status: string } };
    };
    const body = result.body as ResponseBody;
    expect(body.data.job.id).toBe(IN_FLIGHT_JOB_ID);
    expect(body.data.job.status).toBe("running");
  });

  it("returns 500 when Service.currentJobId points at a missing Job (data integrity)", async () => {
    ddbMock.on(GetCommand).callsFakeOnce(() => ({
      Item: baseService({
        status: "deprovisioning",
        jobId: IN_FLIGHT_JOB_ID,
        currentJobId: IN_FLIGHT_JOB_ID,
        liveUrl: undefined,
        provisionedAt: undefined,
      }),
    })).callsFake(() => ({ Item: undefined }));

    const result = await callDeprovision();

    expect(result.kind).toBe("internal-error");
    expect(result.statusCode).toBe(500);
  });
});

// ===========================================================================
// Status routing — 404 paths (archived, not-owned, missing)
// ===========================================================================

describe("deprovisionService — 404 paths", () => {
  it("returns 404 NOT_FOUND when Service item does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await callDeprovision();

    expect(result.kind).toBe("not-found");
    expect(result.statusCode).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "NOT_FOUND",
    );
  });

  it("returns 404 NOT_FOUND when Service exists but is not owned by caller (no leak)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: baseService({ ownerId: OTHER_OWNER }),
    });

    const result = await callDeprovision();

    expect(result.kind).toBe("not-found");
    expect(result.statusCode).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "NOT_FOUND",
    );
  });

  it("returns 404 NOT_FOUND when Service is already archived (don't leak existence)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: baseService({
        status: "archived",
        archivedAt: TIMESTAMP,
        liveUrl: undefined,
        provisionedAt: undefined,
      }),
    });

    const result = await callDeprovision();

    expect(result.kind).toBe("not-found");
    expect(result.statusCode).toBe(404);
  });
});

// ===========================================================================
// Schema-violation handling (parse failure)
// ===========================================================================

describe("deprovisionService — internal errors", () => {
  it("returns 500 when DDB row fails ServiceSchema validation", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...baseService(), status: "ghost" },
    });

    const result = await callDeprovision();

    expect(result.kind).toBe("internal-error");
    expect(result.statusCode).toBe(500);
  });
});
