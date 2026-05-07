import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { getJob } from "./get-job.js";

const ddbMock = mockClient(docClient);

const TABLE = "ironforge-test";
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999999";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
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

const baseJobItem = (overrides: Record<string, unknown> = {}) => ({
  PK: `JOB#${JOB_ID}`,
  SK: "META",
  GSI1PK: `SERVICE#${SERVICE_ID}`,
  GSI1SK: `JOB#${TIMESTAMP}#${JOB_ID}`,
  id: JOB_ID,
  serviceId: SERVICE_ID,
  ownerId: OWNER,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  status: "running",
  startedAt: TIMESTAMP,
  executionArn:
    "arn:aws:states:us-east-1:000000000000:execution:ironforge-test-provisioning:" +
    JOB_ID,
  ...overrides,
});

beforeEach(() => {
  ddbMock.reset();
});

const call = (overrides: Partial<{ ownerId: string }> = {}) =>
  getJob({
    tableName: TABLE,
    serviceId: SERVICE_ID,
    ownerId: overrides.ownerId ?? OWNER,
  });

describe("getJob — happy path", () => {
  it("returns the most recently-created Job for the service", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseService() });
    ddbMock.on(QueryCommand).resolves({ Items: [baseJobItem()] });

    const result = await call();

    expect(result.kind).toBe("ok");
    expect(result.statusCode).toBe(200);
    if (result.kind !== "ok") return;
    expect(result.body.ok).toBe(true);
    expect(result.body.data.job).not.toBeNull();
    expect(result.body.data.job?.id).toBe(JOB_ID);
    expect(result.body.data.job?.status).toBe("running");

    // Query targets GSI1 with descending sort + Limit=1.
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.IndexName).toBe("GSI1");
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(1);
    expect(input.ExpressionAttributeValues?.[":svc"]).toBe(`SERVICE#${SERVICE_ID}`);
  });

  it("strips DynamoDB key attributes before parsing the Job", async () => {
    // The mock returns an item with PK/SK/GSI1PK/GSI1SK present; the
    // parser would fail if those leaked into the schema validation. The
    // assertion that result.kind === "ok" implicitly covers stripping.
    ddbMock.on(GetCommand).resolves({ Item: baseService() });
    ddbMock.on(QueryCommand).resolves({ Items: [baseJobItem()] });

    const result = await call();
    expect(result.kind).toBe("ok");
  });

  it("returns null when the service has no Jobs", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseService() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await call();

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.body.data.job).toBeNull();
  });
});

describe("getJob — terminal-state services", () => {
  it("returns the most recent Job for an archived Service (no tombstoning)", async () => {
    // Archived services SHOULD still surface their final Job for
    // post-deprovisioning review on the detail page. Distinct from
    // DELETE's behavior, which DOES tombstone archived services as 404.
    ddbMock.on(GetCommand).resolves({
      Item: baseService({
        status: "archived",
        archivedAt: TIMESTAMP,
        currentJobId: null,
      }),
    });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        baseJobItem({
          status: "succeeded",
          completedAt: TIMESTAMP,
        }),
      ],
    });

    const result = await call();

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.body.data.job?.status).toBe("succeeded");
  });
});

describe("getJob — authorization", () => {
  it("returns 404 when the service is not owned by the caller", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseService({ ownerId: OTHER_OWNER }) });

    const result = await call();

    expect(result.kind).toBe("not-found");
    expect(result.statusCode).toBe(404);
    // No Job query attempted — short-circuit on ownership.
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns 404 when the service does not exist", async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await call();

    expect(result.kind).toBe("not-found");
    expect(result.statusCode).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe("getJob — fail-loud on schema violation", () => {
  it("returns 500 when the Service item is malformed", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseService(), status: "ghost" } });

    const result = await call();

    expect(result.kind).toBe("internal-error");
    expect(result.statusCode).toBe(500);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns 500 when the Job item is malformed", async () => {
    ddbMock.on(GetCommand).resolves({ Item: baseService() });
    ddbMock.on(QueryCommand).resolves({
      Items: [{ ...baseJobItem(), status: "ghost" }],
    });

    const result = await call();

    expect(result.kind).toBe("internal-error");
    expect(result.statusCode).toBe(500);
  });
});
