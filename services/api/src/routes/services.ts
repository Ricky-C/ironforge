import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildServiceGSI1PK,
  buildServicePK,
  ServiceListCursorSchema,
  ServiceSchema,
  SERVICE_SK_META,
  type ApiFailure,
  type ApiResponse,
  type Service,
  type ServiceListCursor,
} from "@ironforge/shared-types";
import { docClient, getTableName } from "@ironforge/shared-utils";
import type { Context } from "hono";
import { Hono } from "hono";
import { flattenError } from "zod";

import type { AppEnv } from "../env.js";
import { createService } from "../lib/create-service.js";
import { decodeServiceListCursor, encodeServiceListCursor } from "../lib/cursor.js";
import { deprovisionService } from "../lib/deprovision-service.js";

const STATE_MACHINE_ARN_ENV = "PROVISIONING_STATE_MACHINE_ARN";
const DEPROVISIONING_STATE_MACHINE_ARN_ENV = "DEPROVISIONING_STATE_MACHINE_ARN";

const getStateMachineArnFromEnv = (): string => {
  const arn = process.env[STATE_MACHINE_ARN_ENV];
  if (!arn) {
    throw new Error(
      "PROVISIONING_STATE_MACHINE_ARN env var is not set. Lambda config must populate it.",
    );
  }
  return arn;
};

const getDeprovisioningStateMachineArnFromEnv = (): string => {
  const arn = process.env[DEPROVISIONING_STATE_MACHINE_ARN_ENV];
  if (!arn) {
    throw new Error(
      "DEPROVISIONING_STATE_MACHINE_ARN env var is not set. Lambda config must populate it.",
    );
  }
  return arn;
};

export const servicesRoutes = new Hono<AppEnv>();

// Common response shapes
const NOT_FOUND_BODY: ApiFailure = {
  ok: false,
  error: { code: "NOT_FOUND", message: "service not found" },
};
const INTERNAL_BODY: ApiFailure = {
  ok: false,
  error: { code: "INTERNAL", message: "internal server error" },
};

// UUID v4 (or any RFC4122 variant) — matches the format the workflow
// uses for service ids. Validated upfront so a bad path doesn't reach
// DynamoDB.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Strips DynamoDB single-table key attributes from an unmarshalled item
// so the remainder validates cleanly against ServiceSchema. PK/SK/GSI1PK/
// GSI1SK are derivable from Service fields via buildServiceKeys; carrying
// them on the entity-shape would only cause double-source-of-truth bugs.
const stripServiceItemKeys = (item: Record<string, unknown>): Record<string, unknown> => {
  const result = { ...item };
  delete result["PK"];
  delete result["SK"];
  delete result["GSI1PK"];
  delete result["GSI1SK"];
  return result;
};

// Parses a DynamoDB-returned item into a typed Service. On failure logs
// structured detail (item keys only — never the full content, which may
// contain customer data) and throws — caught by the route handler's
// outer try/catch and turned into 500 INTERNAL. Per Phase 1's "fail
// loud" discipline (docs/tech-debt.md): malformed items are bugs,
// surface them rather than silently dropping or partial-rendering.
const parseServiceItem = (
  item: Record<string, unknown>,
  c: Context<AppEnv>,
): Service => {
  const stripped = stripServiceItemKeys(item);
  const result = ServiceSchema.safeParse(stripped);
  if (!result.success) {
    c.get("logger").error("service item failed schema validation", {
      itemKey: { PK: item["PK"], SK: item["SK"] },
      zodErrors: flattenError(result.error),
      userId: c.get("user").sub,
    });
    throw new Error("SERVICE_PARSE_FAILURE");
  }
  return result.data;
};

// Discriminated logging for DynamoDB errors. Response is always 500
// INTERNAL (per CLAUDE.md error sanitization), but operators can alarm
// differentially via CloudWatch metric filters on the log message.
const logDynamoError = (err: unknown, c: Context<AppEnv>, action: string): void => {
  const logger = c.get("logger");
  if (err instanceof Error) {
    const errorName = err.name;
    const errorMessage = err.message;
    if (errorName === "ResourceNotFoundException") {
      logger.error("DynamoDB table not found — deployment/config issue", {
        action,
        errorName,
      });
    } else if (errorName === "AccessDeniedException") {
      logger.error("DynamoDB AccessDenied — IAM grant issue", {
        action,
        errorName,
      });
    } else {
      logger.error("DynamoDB unexpected error", { action, errorName, errorMessage });
    }
  } else {
    logger.error("DynamoDB non-Error exception", { action, value: String(err) });
  }
};

// Query-param validators. Manual rather than Zod-coerced so the raw
// received value flows into error messages (e.g. "got: abc", not "got:
// NaN" after coercion).
type LimitResult = { ok: true; value: number } | { ok: false; raw: string };
const parseLimit = (raw: string | undefined): LimitResult => {
  if (raw === undefined) return { ok: true, value: 20 };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    return { ok: false, raw };
  }
  return { ok: true, value: parsed };
};

type OrderResult = { ok: true; scanForward: boolean } | { ok: false; raw: string };
const parseOrder = (raw: string | undefined): OrderResult => {
  if (raw === undefined || raw === "newest_first") {
    return { ok: true, scanForward: false };
  }
  if (raw === "oldest_first") {
    return { ok: true, scanForward: true };
  }
  return { ok: false, raw };
};

// -----------------------------------------------------------------------
// POST /api/services — create a Service + Job + kick off provisioning
// -----------------------------------------------------------------------

servicesRoutes.post("/", async (c) => {
  const user = c.get("user");
  const idempotencyKey = c.req.header("Idempotency-Key");

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    const body: ApiFailure = {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "request body is not valid JSON" },
    };
    return c.json(body, 400);
  }

  try {
    const result = await createService({
      tableName: getTableName(),
      stateMachineArn: getStateMachineArnFromEnv(),
      ownerId: user.sub,
      body: rawBody,
      idempotencyKey,
    });

    const status = result.statusCode as 200 | 201 | 400 | 409 | 500;
    return c.json(result.body as Record<string, unknown>, status);
  } catch (err) {
    logDynamoError(err, c, "POST /api/services");
    return c.json(INTERNAL_BODY, 500);
  }
});

// -----------------------------------------------------------------------
// GET /api/services — list owner-scoped services, cursor-paginated
// -----------------------------------------------------------------------

servicesRoutes.get("/", async (c) => {
  const user = c.get("user");
  const logger = c.get("logger");

  const limitParsed = parseLimit(c.req.query("limit"));
  if (!limitParsed.ok) {
    const body: ApiFailure = {
      ok: false,
      error: {
        code: "INVALID_LIMIT",
        message: `limit must be an integer between 1 and 100, got: ${limitParsed.raw}`,
      },
    };
    return c.json(body, 400);
  }

  const orderParsed = parseOrder(c.req.query("order"));
  if (!orderParsed.ok) {
    const body: ApiFailure = {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `order must be "newest_first" or "oldest_first", got: ${orderParsed.raw}`,
      },
    };
    return c.json(body, 400);
  }

  const cursorParam = c.req.query("cursor");
  let exclusiveStartKey: ServiceListCursor | undefined;
  if (cursorParam !== undefined) {
    const decoded = decodeServiceListCursor(cursorParam);
    if (decoded === null) {
      const body: ApiFailure = {
        ok: false,
        error: { code: "INVALID_CURSOR", message: "cursor failed validation" },
      };
      return c.json(body, 400);
    }
    exclusiveStartKey = decoded;
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: getTableName(),
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :owner",
        ExpressionAttributeValues: {
          ":owner": buildServiceGSI1PK(user.sub),
        },
        Limit: limitParsed.value,
        ScanIndexForward: orderParsed.scanForward,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    const items: Service[] = (result.Items ?? []).map((item) =>
      parseServiceItem(item as Record<string, unknown>, c),
    );

    let nextCursor: string | null = null;
    if (result.LastEvaluatedKey) {
      const cursorResult = ServiceListCursorSchema.safeParse(result.LastEvaluatedKey);
      if (!cursorResult.success) {
        // DynamoDB returned a LastEvaluatedKey shape we don't recognize.
        // Programming error (wrong index, schema drift) — fail loud.
        logger.error("LastEvaluatedKey did not match cursor schema", {
          zodErrors: flattenError(cursorResult.error),
          userId: user.sub,
        });
        throw new Error("CURSOR_ENCODE_FAILURE");
      }
      nextCursor = encodeServiceListCursor(cursorResult.data);
    }

    const body: ApiResponse<{ items: Service[]; cursor: string | null }> = {
      ok: true,
      data: { items, cursor: nextCursor },
    };
    return c.json(body, 200);
  } catch (err) {
    if (err instanceof Error && err.message === "SERVICE_PARSE_FAILURE") {
      // Already logged in parseServiceItem; convert to 500.
      return c.json(INTERNAL_BODY, 500);
    }
    if (err instanceof Error && err.message === "CURSOR_ENCODE_FAILURE") {
      // Already logged above; convert to 500.
      return c.json(INTERNAL_BODY, 500);
    }
    logDynamoError(err, c, "Query GSI1");
    return c.json(INTERNAL_BODY, 500);
  }
});

// -----------------------------------------------------------------------
// GET /api/services/:id — single service detail, owner-checked
// -----------------------------------------------------------------------

servicesRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  // Validate :id upfront so a bad path doesn't reach DynamoDB.
  if (!UUID_PATTERN.test(id)) {
    const body: ApiFailure = {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "id must be a UUID" },
    };
    return c.json(body, 400);
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: getTableName(),
        Key: { PK: buildServicePK(id), SK: SERVICE_SK_META },
      }),
    );

    if (!result.Item) {
      // Genuine 404. Same envelope as the "found but not owned" case
      // below — clients cannot distinguish.
      return c.json(NOT_FOUND_BODY, 404);
    }

    const service = parseServiceItem(result.Item as Record<string, unknown>, c);

    if (service.ownerId !== user.sub) {
      // Found but not owned by the requester. Returns the SAME 404
      // envelope as the genuine-not-found case — never leak service
      // existence via response shape (see docs/data-model.md §
      // Authorization).
      return c.json(NOT_FOUND_BODY, 404);
    }

    const body: ApiResponse<Service> = { ok: true, data: service };
    return c.json(body, 200);
  } catch (err) {
    if (err instanceof Error && err.message === "SERVICE_PARSE_FAILURE") {
      return c.json(INTERNAL_BODY, 500);
    }
    logDynamoError(err, c, "GetItem service detail");
    return c.json(INTERNAL_BODY, 500);
  }
});

// -----------------------------------------------------------------------
// DELETE /api/services/:id — kick off deprovisioning (Phase 1.5)
// -----------------------------------------------------------------------
//
// Status routing:
//   - pending | provisioning  → 409 SERVICE_IN_FLIGHT (caller waits;
//                                cancellation is Phase 2+)
//   - live | failed           → 202 with new deprovisioning Job
//   - deprovisioning          → 202 with the existing in-flight Job
//                                (idempotent re-DELETE)
//   - archived | not-found    → 404 (same envelope; no leak)
//
// All status decisions live in lib/deprovision-service.ts. The route
// handler does HTTP-level concerns: UUID validation, env resolution,
// status-code mapping.

servicesRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  if (!UUID_PATTERN.test(id)) {
    const body: ApiFailure = {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "id must be a UUID" },
    };
    return c.json(body, 400);
  }

  try {
    const result = await deprovisionService({
      tableName: getTableName(),
      deprovisioningStateMachineArn: getDeprovisioningStateMachineArnFromEnv(),
      ownerId: user.sub,
      serviceId: id,
    });
    return c.json(result.body as Record<string, unknown>, result.statusCode);
  } catch (err) {
    logDynamoError(err, c, "DELETE /api/services/:id");
    return c.json(INTERNAL_BODY, 500);
  }
});
