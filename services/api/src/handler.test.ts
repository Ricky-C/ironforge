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

const ORIGINAL_TABLE_NAME = process.env["DYNAMODB_TABLE_NAME"];
beforeAll(() => {
  process.env["DYNAMODB_TABLE_NAME"] = "ironforge-test";
});
afterAll(() => {
  if (ORIGINAL_TABLE_NAME === undefined) {
    delete process.env["DYNAMODB_TABLE_NAME"];
  } else {
    process.env["DYNAMODB_TABLE_NAME"] = ORIGINAL_TABLE_NAME;
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
