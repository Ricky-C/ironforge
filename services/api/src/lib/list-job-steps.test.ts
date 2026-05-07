import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { listJobSteps } from "./list-job-steps.js";

const ddbMock = mockClient(docClient);

const TABLE = "ironforge-test";
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999999";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SERVICE_ID = "88888888-8888-4888-8888-888888888888";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
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
  currentJobId: JOB_ID,
  status: "provisioning",
  jobId: JOB_ID,
  ...overrides,
});

const baseJobMeta = (overrides: Record<string, unknown> = {}) => ({
  PK: `JOB#${JOB_ID}`,
  SK: "META",
  id: JOB_ID,
  serviceId: SERVICE_ID,
  ownerId: OWNER,
  createdAt: TIMESTAMP,
  status: "running",
  ...overrides,
});

const stepRunning = (stepName: string, overrides: Record<string, unknown> = {}) => ({
  PK: `JOB#${JOB_ID}`,
  SK: `STEP#${stepName}`,
  jobId: JOB_ID,
  stepName,
  attempts: 1,
  updatedAt: TIMESTAMP,
  status: "running",
  startedAt: TIMESTAMP,
  ...overrides,
});

const stepSucceeded = (stepName: string, overrides: Record<string, unknown> = {}) => ({
  PK: `JOB#${JOB_ID}`,
  SK: `STEP#${stepName}`,
  jobId: JOB_ID,
  stepName,
  attempts: 1,
  updatedAt: TIMESTAMP,
  status: "succeeded",
  startedAt: TIMESTAMP,
  completedAt: TIMESTAMP,
  output: {},
  ...overrides,
});

beforeEach(() => {
  ddbMock.reset();
});

const call = (overrides: Partial<{ ownerId: string; serviceId: string; jobId: string }> = {}) =>
  listJobSteps({
    tableName: TABLE,
    serviceId: overrides.serviceId ?? SERVICE_ID,
    jobId: overrides.jobId ?? JOB_ID,
    ownerId: overrides.ownerId ?? OWNER,
  });

describe("listJobSteps — happy path", () => {
  it("returns step entries for the job", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({ Item: baseService() });
    ddbMock
      .on(GetCommand, { Key: { PK: `JOB#${JOB_ID}`, SK: "META" } })
      .resolves({ Item: baseJobMeta() });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        stepSucceeded("validate-inputs"),
        stepSucceeded("create-repo"),
        stepRunning("generate-code"),
      ],
    });

    const result = await call();

    expect(result.kind).toBe("ok");
    expect(result.statusCode).toBe(200);
    if (result.kind !== "ok") return;
    expect(result.body.data.items).toHaveLength(3);
    expect(result.body.data.items.map((s) => s.stepName)).toEqual([
      "validate-inputs",
      "create-repo",
      "generate-code",
    ]);

    // Query targets base table (no IndexName), PK = JOB#<jobId>, SK
    // begins_with STEP#.
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.IndexName).toBeUndefined();
    expect(input.ExpressionAttributeValues?.[":pk"]).toBe(`JOB#${JOB_ID}`);
    expect(input.ExpressionAttributeValues?.[":stepPrefix"]).toBe("STEP#");
  });

  it("returns an empty list when no steps have been written yet", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({ Item: baseService() });
    ddbMock
      .on(GetCommand, { Key: { PK: `JOB#${JOB_ID}`, SK: "META" } })
      .resolves({ Item: baseJobMeta() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await call();

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.body.data.items).toEqual([]);
  });
});

describe("listJobSteps — authorization", () => {
  it("returns 404 when the service is not owned by the caller", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({ Item: baseService({ ownerId: OTHER_OWNER }) });

    const result = await call();

    expect(result.kind).toBe("not-found");
    expect(result.statusCode).toBe(404);
    // Short-circuit on Service ownership — no Job lookup, no step query.
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns 404 when the service does not exist", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({});

    const result = await call();

    expect(result.kind).toBe("not-found");
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns 404 when the job belongs to a different service", async () => {
    // Cross-service URL traversal — caller owns SERVICE_ID but is asking
    // for steps of a Job that belongs to a different service.
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({ Item: baseService() });
    ddbMock
      .on(GetCommand, { Key: { PK: `JOB#${JOB_ID}`, SK: "META" } })
      .resolves({ Item: baseJobMeta({ serviceId: OTHER_SERVICE_ID }) });

    const result = await call();

    expect(result.kind).toBe("not-found");
    expect(result.statusCode).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns 404 when the job does not exist", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({ Item: baseService() });
    ddbMock
      .on(GetCommand, { Key: { PK: `JOB#${JOB_ID}`, SK: "META" } })
      .resolves({});

    const result = await call();

    expect(result.kind).toBe("not-found");
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe("listJobSteps — fail-loud on schema violation", () => {
  it("returns 500 when the Service item is malformed", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({ Item: { ...baseService(), status: "ghost" } });

    const result = await call();

    expect(result.kind).toBe("internal-error");
    expect(result.statusCode).toBe(500);
  });

  it("returns 500 when a step item is malformed", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({ Item: baseService() });
    ddbMock
      .on(GetCommand, { Key: { PK: `JOB#${JOB_ID}`, SK: "META" } })
      .resolves({ Item: baseJobMeta() });
    ddbMock.on(QueryCommand).resolves({
      Items: [{ ...stepSucceeded("validate-inputs"), status: "ghost" }],
    });

    const result = await call();

    expect(result.kind).toBe("internal-error");
    expect(result.statusCode).toBe(500);
  });
});
