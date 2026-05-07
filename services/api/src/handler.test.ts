import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { decodeServiceListCursor } from "./lib/cursor.js";
import type { AuthEnv } from "./middleware/auth.js";
import { createApp } from "./handler.js";

const ddbMock = mockClient(docClient);

const VALID_SUB = "11111111-1111-4111-8111-111111111111";
const OTHER_SUB = "99999999-9999-4999-8999-999999999999";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SERVICE_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const TIMESTAMP = "2026-04-30T15:20:34.567Z";

const sampleService = (overrides: Record<string, unknown> = {}) => ({
  id: SERVICE_ID,
  name: "my-site",
  ownerId: VALID_SUB,
  templateId: "static-site",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  inputs: {},
  currentJobId: null,
  status: "pending" as const,
  ...overrides,
});

const sampleItem = (overrides: Record<string, unknown> = {}) => ({
  PK: `SERVICE#${SERVICE_ID}`,
  SK: "META",
  GSI1PK: `OWNER#${VALID_SUB}`,
  GSI1SK: `SERVICE#${TIMESTAMP}#${SERVICE_ID}`,
  ...sampleService(),
  ...overrides,
});

const eventWithClaims = (claims: unknown): AuthEnv["Bindings"]["event"] =>
  ({
    requestContext: {
      authorizer: { jwt: { claims } },
      requestId: "test-request-id",
    },
  }) as unknown as AuthEnv["Bindings"]["event"];

const accessTokenClaims = (overrides: Record<string, unknown> = {}) => ({
  sub: VALID_SUB,
  token_use: "access",
  ...overrides,
});

const callPath = (path: string, claims: unknown) =>
  createApp().request(path, {}, {
    event: eventWithClaims(claims),
  } as AuthEnv["Bindings"]);

const callMethod = (
  path: string,
  method: "GET" | "DELETE" | "POST",
  claims: unknown,
) =>
  createApp().request(path, { method }, {
    event: eventWithClaims(claims),
  } as AuthEnv["Bindings"]);

const ORIGINAL_TABLE_NAME = process.env["DYNAMODB_TABLE_NAME"];
const ORIGINAL_DEPROVISION_ARN = process.env["DEPROVISIONING_STATE_MACHINE_ARN"];
const TEST_DEPROVISION_ARN =
  "arn:aws:states:us-east-1:000000000000:stateMachine:ironforge-test-deprovisioning";
beforeAll(() => {
  process.env["DYNAMODB_TABLE_NAME"] = "ironforge-test";
  process.env["DEPROVISIONING_STATE_MACHINE_ARN"] = TEST_DEPROVISION_ARN;
});
afterAll(() => {
  if (ORIGINAL_TABLE_NAME === undefined) {
    delete process.env["DYNAMODB_TABLE_NAME"];
  } else {
    process.env["DYNAMODB_TABLE_NAME"] = ORIGINAL_TABLE_NAME;
  }
  if (ORIGINAL_DEPROVISION_ARN === undefined) {
    delete process.env["DEPROVISIONING_STATE_MACHINE_ARN"];
  } else {
    process.env["DEPROVISIONING_STATE_MACHINE_ARN"] = ORIGINAL_DEPROVISION_ARN;
  }
});
beforeEach(() => {
  ddbMock.reset();
});

// ===========================================================================
// GET /api/services — list
// ===========================================================================

describe("GET /api/services — happy path", () => {
  it("returns empty envelope when DynamoDB has no Items", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const res = await callPath("/api/services", accessTokenClaims());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { items: [], cursor: null },
    });
  });

  it("returns single page with cursor null when no LastEvaluatedKey", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [sampleItem()] });
    const res = await callPath("/api/services", accessTokenClaims());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { items: unknown[]; cursor: null } };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.cursor).toBeNull();
  });

  it("encodes LastEvaluatedKey as base64url cursor when present", async () => {
    const lastKey = {
      PK: `SERVICE#${SERVICE_ID}`,
      SK: "META",
      GSI1PK: `OWNER#${VALID_SUB}`,
      GSI1SK: `SERVICE#${TIMESTAMP}#${SERVICE_ID}`,
    };
    ddbMock.on(QueryCommand).resolves({
      Items: [sampleItem()],
      LastEvaluatedKey: lastKey,
    });
    const res = await callPath("/api/services", accessTokenClaims());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { items: unknown[]; cursor: string } };
    expect(body.data.cursor).toBeTypeOf("string");
    expect(decodeServiceListCursor(body.data.cursor)).toEqual(lastKey);
  });

  it("strips DynamoDB key attributes from returned items", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [sampleItem()] });
    const res = await callPath("/api/services", accessTokenClaims());
    const body = (await res.json()) as { ok: true; data: { items: Record<string, unknown>[] } };
    const item = body.data.items[0]!;
    expect(item).not.toHaveProperty("PK");
    expect(item).not.toHaveProperty("SK");
    expect(item).not.toHaveProperty("GSI1PK");
    expect(item).not.toHaveProperty("GSI1SK");
    expect(item).toMatchObject({ id: SERVICE_ID, ownerId: VALID_SUB });
  });
});

describe("GET /api/services — query construction", () => {
  it("uses GSI1 with owner partition key from JWT sub", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await callPath("/api/services", accessTokenClaims());
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.IndexName).toBe("GSI1");
    expect(input.KeyConditionExpression).toBe("GSI1PK = :owner");
    expect(input.ExpressionAttributeValues).toEqual({
      ":owner": `OWNER#${VALID_SUB}`,
    });
  });

  it("default order is newest-first (ScanIndexForward false)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await callPath("/api/services", accessTokenClaims());
    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.ScanIndexForward).toBe(false);
  });

  it("order=oldest_first sets ScanIndexForward true", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await callPath("/api/services?order=oldest_first", accessTokenClaims());
    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.ScanIndexForward).toBe(true);
  });

  it("default limit is 20", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await callPath("/api/services", accessTokenClaims());
    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.Limit).toBe(20);
  });

  it("custom limit threads to DynamoDB Limit", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await callPath("/api/services?limit=50", accessTokenClaims());
    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.Limit).toBe(50);
  });

  it("incoming cursor decodes to ExclusiveStartKey", async () => {
    const cursor = {
      PK: `SERVICE#${SERVICE_ID}`,
      SK: "META",
      GSI1PK: `OWNER#${VALID_SUB}`,
      GSI1SK: `SERVICE#${TIMESTAMP}#${SERVICE_ID}`,
    };
    const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await callPath(`/api/services?cursor=${encoded}`, accessTokenClaims());
    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.ExclusiveStartKey).toEqual(cursor);
  });
});

describe("GET /api/services — validation errors", () => {
  it.each([
    ["abc", "non-numeric"],
    ["0", "below min"],
    ["-1", "negative"],
    ["101", "above max"],
    ["1.5", "non-integer"],
  ])("rejects limit=%s (%s) with INVALID_LIMIT preserving raw value", async (raw) => {
    const res = await callPath(`/api/services?limit=${raw}`, accessTokenClaims());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INVALID_LIMIT");
    expect(body.error.message).toContain(raw);
  });

  it("rejects unknown order with INVALID_REQUEST", async () => {
    const res = await callPath("/api/services?order=mystery", accessTokenClaims());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.message).toContain("mystery");
  });

  it.each([
    ["!!!not base64!!!", "malformed base64"],
    ["bm90IGpzb24=", "valid base64 but not JSON"],
    [
      Buffer.from(JSON.stringify({ wrong: "shape" }), "utf8").toString("base64url"),
      "wrong shape",
    ],
  ])("rejects cursor (%s — %s) with INVALID_CURSOR", async (raw) => {
    const res = await callPath(
      `/api/services?cursor=${encodeURIComponent(raw)}`,
      accessTokenClaims(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("does not call DynamoDB when query-param validation fails", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await callPath("/api/services?limit=999", accessTokenClaims());
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/services",
      {},
      { event: { requestContext: { requestId: "x" } } } as AuthEnv["Bindings"],
    );
    expect(res.status).toBe(401);
  });

  it("rejects ID-token requests with 401 (BFF-misconfiguration defense)", async () => {
    const res = await callPath(
      "/api/services",
      accessTokenClaims({ token_use: "id" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/services — failure modes", () => {
  it("returns 500 INTERNAL when an item fails ServiceSchema validation", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [sampleItem({ status: "ghost" })],
    });
    const res = await callPath("/api/services", accessTokenClaims());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL on DynamoDB error", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("simulated DynamoDB failure"));
    const res = await callPath("/api/services", accessTokenClaims());
    expect(res.status).toBe(500);
  });

  it("returns 500 INTERNAL when LastEvaluatedKey shape is unexpected", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [sampleItem()],
      LastEvaluatedKey: { unexpected: "shape" },
    });
    const res = await callPath("/api/services", accessTokenClaims());
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// GET /api/services/:id — detail
// ===========================================================================

describe("GET /api/services/:id — happy path", () => {
  it("returns 200 with service when found and owned", async () => {
    ddbMock.on(GetCommand).resolves({ Item: sampleItem() });
    const res = await callPath(`/api/services/${SERVICE_ID}`, accessTokenClaims());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ id: SERVICE_ID, ownerId: VALID_SUB });
    expect(body.data).not.toHaveProperty("PK");
  });

  it("uses correct base-table key construction", async () => {
    ddbMock.on(GetCommand).resolves({ Item: sampleItem() });
    await callPath(`/api/services/${SERVICE_ID}`, accessTokenClaims());
    const input = ddbMock.commandCalls(GetCommand)[0]!.args[0].input;
    expect(input.Key).toEqual({ PK: `SERVICE#${SERVICE_ID}`, SK: "META" });
  });

  it("returns 200 for in-flight (provisioning) service with both jobId + currentJobId set", async () => {
    // Schema-compliance regression: create-service.ts writes BOTH jobId
    // (the denormalized snapshot required by ServiceProvisioningSchema's
    // discriminated union) and currentJobId (the operational "is a Job
    // active?" pointer). A GET during the in-flight window must return
    // a row that parses cleanly against the variant. Without the kickoff
    // fix this test 500s with SERVICE_PARSE_FAILURE.
    const JOB_ID = "44444444-4444-4444-8444-444444444444";
    ddbMock.on(GetCommand).resolves({
      Item: sampleItem({
        status: "provisioning",
        jobId: JOB_ID,
        currentJobId: JOB_ID,
      }),
    });
    const res = await callPath(`/api/services/${SERVICE_ID}`, accessTokenClaims());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id: SERVICE_ID,
      status: "provisioning",
      jobId: JOB_ID,
      currentJobId: JOB_ID,
    });
  });
});

describe("GET /api/services/:id — 404 envelope shape parity", () => {
  const expected404Body = {
    ok: false,
    error: { code: "NOT_FOUND", message: "service not found" },
  };

  it("genuine not-found returns canonical envelope", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await callPath(`/api/services/${SERVICE_ID}`, accessTokenClaims());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(expected404Body);
  });

  it("found-but-not-owned returns BYTE-IDENTICAL envelope to genuine not-found", async () => {
    // Service exists but ownerId belongs to a different user. The
    // response shape MUST match the genuine 404 — clients cannot
    // distinguish existence via response shape (docs/data-model.md §
    // Authorization).
    ddbMock
      .on(GetCommand)
      .resolves({ Item: sampleItem({ ownerId: OTHER_SUB }) });
    const res = await callPath(
      `/api/services/${OTHER_SERVICE_ID}`,
      accessTokenClaims(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(expected404Body);
  });
});

describe("GET /api/services/:id — validation errors", () => {
  it.each(["abc", "not-a-uuid", "12345", "11111111-1111-4111-8111"])(
    "rejects bad id %j with 400 INVALID_REQUEST",
    async (badId) => {
      const res = await callPath(`/api/services/${badId}`, accessTokenClaims());
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_REQUEST");
    },
  );

  it("does not call DynamoDB when id validation fails", async () => {
    ddbMock.on(GetCommand).resolves({ Item: sampleItem() });
    await callPath("/api/services/not-a-uuid", accessTokenClaims());
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("rejects unauthenticated detail requests with 401 (no path-leak via 404)", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/services/${SERVICE_ID}`,
      {},
      { event: { requestContext: { requestId: "x" } } } as AuthEnv["Bindings"],
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/services/:id — failure modes", () => {
  it("returns 500 INTERNAL when item fails ServiceSchema validation", async () => {
    ddbMock.on(GetCommand).resolves({ Item: sampleItem({ status: "ghost" }) });
    const res = await callPath(`/api/services/${SERVICE_ID}`, accessTokenClaims());
    expect(res.status).toBe(500);
  });

  it("returns 500 INTERNAL on DynamoDB error", async () => {
    ddbMock.on(GetCommand).rejects(new Error("simulated DynamoDB failure"));
    const res = await callPath(`/api/services/${SERVICE_ID}`, accessTokenClaims());
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// DELETE /api/services/:id — route-level coverage (lib logic in
// services/api/src/lib/deprovision-service.test.ts)
// ===========================================================================

describe("DELETE /api/services/:id — validation + 404 envelope parity", () => {
  it.each(["abc", "not-a-uuid", "12345", "11111111-1111-4111-8111"])(
    "rejects bad id %j with 400 INVALID_REQUEST",
    async (badId) => {
      const res = await callMethod(
        `/api/services/${badId}`,
        "DELETE",
        accessTokenClaims(),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_REQUEST");
    },
  );

  it("rejects unauthenticated DELETE with 401 (no path-leak via 404)", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/services/${SERVICE_ID}`,
      { method: "DELETE" },
      { event: { requestContext: { requestId: "x" } } } as AuthEnv["Bindings"],
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 NOT_FOUND when item does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await callMethod(
      `/api/services/${SERVICE_ID}`,
      "DELETE",
      accessTokenClaims(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "service not found" },
    });
  });

  it("returns 404 with byte-identical envelope when service is found-but-not-owned", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: sampleItem({ ownerId: OTHER_SUB }),
    });
    const res = await callMethod(
      `/api/services/${SERVICE_ID}`,
      "DELETE",
      accessTokenClaims(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "service not found" },
    });
  });

  it("returns 404 NOT_FOUND when service is already archived (don't leak existence)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: sampleItem({
        status: "archived",
        archivedAt: TIMESTAMP,
      }),
    });
    const res = await callMethod(
      `/api/services/${SERVICE_ID}`,
      "DELETE",
      accessTokenClaims(),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/services/:id — 409 SERVICE_IN_FLIGHT", () => {
  it("returns 409 with currentState when service is provisioning", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: sampleItem({
        status: "provisioning",
        jobId: "44444444-4444-4444-8444-444444444444",
        currentJobId: "44444444-4444-4444-8444-444444444444",
      }),
    });
    const res = await callMethod(
      `/api/services/${SERVICE_ID}`,
      "DELETE",
      accessTokenClaims(),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; currentState: string };
    };
    expect(body.error.code).toBe("SERVICE_IN_FLIGHT");
    expect(body.error.currentState).toBe("provisioning");
  });
});

// ===========================================================================
// GET /api/services/:id/job — most-recent Job (subphase 2.4-A.2)
// ===========================================================================

const sampleJobItem = (overrides: Record<string, unknown> = {}) => ({
  PK: `JOB#${JOB_ID}`,
  SK: "META",
  GSI1PK: `SERVICE#${SERVICE_ID}`,
  GSI1SK: `JOB#${TIMESTAMP}#${JOB_ID}`,
  id: JOB_ID,
  serviceId: SERVICE_ID,
  ownerId: VALID_SUB,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  status: "running" as const,
  startedAt: TIMESTAMP,
  executionArn:
    "arn:aws:states:us-east-1:000000000000:execution:ironforge-test-provisioning:" +
    JOB_ID,
  ...overrides,
});

describe("GET /api/services/:id/job — happy path", () => {
  it("returns 200 with the most-recent Job for the service", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: sampleItem({
        status: "provisioning",
        jobId: JOB_ID,
        currentJobId: JOB_ID,
      }),
    });
    ddbMock.on(QueryCommand).resolves({ Items: [sampleJobItem()] });

    const res = await callPath(
      `/api/services/${SERVICE_ID}/job`,
      accessTokenClaims(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { job: { id: string } | null } };
    expect(body.ok).toBe(true);
    expect(body.data.job?.id).toBe(JOB_ID);
  });

  it("returns 200 with job: null when the service has no Jobs", async () => {
    ddbMock.on(GetCommand).resolves({ Item: sampleItem() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await callPath(
      `/api/services/${SERVICE_ID}/job`,
      accessTokenClaims(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { job: null } };
    expect(body.data.job).toBeNull();
  });
});

describe("GET /api/services/:id/job — validation + auth", () => {
  it("rejects non-UUID id with 400 INVALID_REQUEST", async () => {
    const res = await callPath("/api/services/not-a-uuid/job", accessTokenClaims());
    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/services/${SERVICE_ID}/job`,
      {},
      { event: { requestContext: { requestId: "x" } } } as AuthEnv["Bindings"],
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the service is not owned by the caller", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: sampleItem({ ownerId: OTHER_SUB }) });

    const res = await callPath(
      `/api/services/${SERVICE_ID}/job`,
      accessTokenClaims(),
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// GET /api/services/:id/jobs/:jobId/steps — JobStep list (subphase 2.4-A.2)
// ===========================================================================

const sampleStepItem = (
  stepName: string,
  overrides: Record<string, unknown> = {},
) => ({
  PK: `JOB#${JOB_ID}`,
  SK: `STEP#${stepName}`,
  jobId: JOB_ID,
  stepName,
  attempts: 1,
  updatedAt: TIMESTAMP,
  status: "succeeded" as const,
  startedAt: TIMESTAMP,
  completedAt: TIMESTAMP,
  output: {},
  ...overrides,
});

describe("GET /api/services/:id/jobs/:jobId/steps — happy path", () => {
  it("returns 200 with step entries for the job", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({
        Item: sampleItem({
          status: "provisioning",
          jobId: JOB_ID,
          currentJobId: JOB_ID,
        }),
      });
    ddbMock
      .on(GetCommand, { Key: { PK: `JOB#${JOB_ID}`, SK: "META" } })
      .resolves({ Item: sampleJobItem() });
    ddbMock.on(QueryCommand).resolves({
      Items: [sampleStepItem("validate-inputs"), sampleStepItem("create-repo")],
    });

    const res = await callPath(
      `/api/services/${SERVICE_ID}/jobs/${JOB_ID}/steps`,
      accessTokenClaims(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { items: Array<{ stepName: string }> };
    };
    expect(body.data.items.map((s) => s.stepName)).toEqual([
      "validate-inputs",
      "create-repo",
    ]);
  });
});

describe("GET /api/services/:id/jobs/:jobId/steps — validation + auth", () => {
  it("rejects non-UUID service id with 400", async () => {
    const res = await callPath(
      `/api/services/not-a-uuid/jobs/${JOB_ID}/steps`,
      accessTokenClaims(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-UUID jobId with 400", async () => {
    const res = await callPath(
      `/api/services/${SERVICE_ID}/jobs/not-a-uuid/steps`,
      accessTokenClaims(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/services/${SERVICE_ID}/jobs/${JOB_ID}/steps`,
      {},
      { event: { requestContext: { requestId: "x" } } } as AuthEnv["Bindings"],
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the job belongs to a different service", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `SERVICE#${SERVICE_ID}`, SK: "META" } })
      .resolves({
        Item: sampleItem({
          status: "provisioning",
          jobId: JOB_ID,
          currentJobId: JOB_ID,
        }),
      });
    ddbMock
      .on(GetCommand, { Key: { PK: `JOB#${JOB_ID}`, SK: "META" } })
      .resolves({ Item: sampleJobItem({ serviceId: OTHER_SERVICE_ID }) });

    const res = await callPath(
      `/api/services/${SERVICE_ID}/jobs/${JOB_ID}/steps`,
      accessTokenClaims(),
    );
    expect(res.status).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

// ===========================================================================
// /api/demo/* — subphase 2.6 unauthenticated demo surface
//
// Scope: envelope-shape spot checks + DELETE on static-* → 404 (defense
// in depth; frontend will also gate the button in PR-B). Auth-bypass at
// the gateway level is verified post-apply via curl per PR description
// (route-level NONE-vs-gateway-authorizer is gateway behavior, not
// Lambda behavior — testing it via Hono mocks would test library code,
// not the integration we care about).
// ===========================================================================

const callDemoPath = (path: string, init: RequestInit = {}) =>
  createApp().request(path, init, {
    // Demo routes hit Lambda without authorizer claims — gateway-level
    // route NONE doesn't populate event.requestContext.authorizer.
    // Mirror that here by passing only requestContext (no .authorizer).
    event: { requestContext: { requestId: "demo-test" } },
  } as AuthEnv["Bindings"]);

describe("GET /api/demo/health", () => {
  it("returns 200 envelope shape (no auth required)", async () => {
    const res = await callDemoPath("/api/demo/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
  });
});

describe("GET /api/demo/services", () => {
  it("returns 200 with 3 catalog entries (live + provisioning + failed)", async () => {
    const res = await callDemoPath("/api/demo/services");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { items: Array<{ status: string }>; cursor: string | null };
    };
    expect(body.data.items).toHaveLength(3);
    const statuses = body.data.items.map((s) => s.status).sort();
    expect(statuses).toEqual(["failed", "live", "provisioning"]);
    expect(body.data.cursor).toBeNull();
  });
});

describe("GET /api/demo/services/:id", () => {
  it("returns 200 for a known static demo id", async () => {
    const res = await callDemoPath(
      "/api/demo/services/11111111-1111-4111-8111-111111111111",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { status: string } };
    expect(body.data.status).toBe("live");
  });

  it("returns 404 for an unrecognized id", async () => {
    const res = await callDemoPath(
      "/api/demo/services/99999999-9999-4999-8999-999999999999",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/demo/services", () => {
  it("returns 201 with service+job composite (envelope shape)", async () => {
    const res = await callDemoPath("/api/demo/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "demo-test",
        templateId: "static-site",
        inputs: {},
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: true;
      data: {
        service: { id: string; name: string; status: string };
        job: { id: string; status: string };
      };
    };
    expect(body.data.service.name).toBe("demo-test");
    // Service starts in pending or provisioning depending on the
    // sub-millisecond elapsed time between generateEphemeralServiceId
    // and getDemoService inside the handler. Either is valid for a
    // freshly-created ephemeral.
    expect(["pending", "provisioning"]).toContain(body.data.service.status);
    expect(body.data.job.id).toBeTruthy();
  });
});

describe("DELETE /api/demo/services/:id — defense in depth on static catalog", () => {
  // Static catalog services are not deprovisionable. Backend enforces
  // here so a stale frontend or scripted client can't remove demo
  // catalog entries by guessing IDs. Frontend (PR-B) also gates the
  // button.
  it("returns 404 on the live static service", async () => {
    const res = await callDemoPath(
      "/api/demo/services/11111111-1111-4111-8111-111111111111",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 on the provisioning static service", async () => {
    const res = await callDemoPath(
      "/api/demo/services/22222222-2222-4222-8222-222222222222",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 on the failed static service", async () => {
    const res = await callDemoPath(
      "/api/demo/services/33333333-3333-4333-8333-333333333333",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/demo/services/:id/job + /steps", () => {
  const LIVE_STATIC_ID = "11111111-1111-4111-8111-111111111111";
  const LIVE_STATIC_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("/job returns 200 with the live static service's succeeded Job", async () => {
    const res = await callDemoPath(`/api/demo/services/${LIVE_STATIC_ID}/job`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { job: { status: string } };
    };
    expect(body.data.job.status).toBe("succeeded");
  });

  it("/jobs/:jobId/steps returns 200 with all 8 succeeded steps for the live static service", async () => {
    const res = await callDemoPath(
      `/api/demo/services/${LIVE_STATIC_ID}/jobs/${LIVE_STATIC_JOB_ID}/steps`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { items: Array<{ status: string }> };
    };
    expect(body.data.items).toHaveLength(8);
    for (const step of body.data.items) {
      expect(step.status).toBe("succeeded");
    }
  });
});

// ===========================================================================
// Unknown /api/* routes (preserved from PR-B.2)
// ===========================================================================

describe("unknown /api/* routes", () => {
  it("authenticated request to an unregistered /api/ path returns 404", async () => {
    const res = await callPath("/api/nope", accessTokenClaims());
    expect(res.status).toBe(404);
  });

  it("unauthenticated request to an unregistered /api/ path returns 401, not 404", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/nope",
      {},
      { event: { requestContext: { requestId: "x" } } } as AuthEnv["Bindings"],
    );
    expect(res.status).toBe(401);
  });
});
