import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildJobGSI1PK,
  buildServicePK,
  JobSchema,
  SERVICE_SK_META,
  ServiceSchema,
  type ApiFailure,
  type ApiSuccess,
  type Job,
} from "@ironforge/shared-types";
import { docClient } from "@ironforge/shared-utils";
import { flattenError } from "zod";

// GET /api/services/:id/job — returns the most recently-created Job for
// the Service (Query GSI1 with PK=SERVICE#<serviceId>, ScanIndexForward
// =false, Limit=1). `null` when the Service has no Jobs yet (transitional
// state during the pending → first-kickoff window).
//
// Owner check pivots through GET Service-by-id; same 404 envelope as the
// GET /:id route for not-found / not-owned. Archived Services are NOT
// tombstoned here — a viewer of an archived service's detail page can
// still inspect prior runs.

type GetJobResponseData = { job: Job | null };

export type GetJobParams = {
  tableName: string;
  serviceId: string;
  ownerId: string;
};

export type GetJobResult =
  | { kind: "ok"; statusCode: 200; body: ApiSuccess<GetJobResponseData> }
  | { kind: "not-found"; statusCode: 404; body: ApiFailure }
  | { kind: "internal-error"; statusCode: 500; body: ApiFailure };

const NOT_FOUND_BODY: ApiFailure = {
  ok: false,
  error: { code: "NOT_FOUND", message: "service not found" },
};

const INTERNAL_BODY: ApiFailure = {
  ok: false,
  error: { code: "INTERNAL", message: "internal server error" },
};

const stripItemKeys = (item: Record<string, unknown>): Record<string, unknown> => {
  const result = { ...item };
  delete result["PK"];
  delete result["SK"];
  delete result["GSI1PK"];
  delete result["GSI1SK"];
  return result;
};

export const getJob = async (params: GetJobParams): Promise<GetJobResult> => {
  // Step 1: ownership check via Service GET.
  const serviceResult = await docClient.send(
    new GetCommand({
      TableName: params.tableName,
      Key: { PK: buildServicePK(params.serviceId), SK: SERVICE_SK_META },
    }),
  );

  if (!serviceResult.Item) {
    return { kind: "not-found", statusCode: 404, body: NOT_FOUND_BODY };
  }

  const serviceParsed = ServiceSchema.safeParse(
    stripItemKeys(serviceResult.Item as Record<string, unknown>),
  );
  if (!serviceParsed.success) {
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "service item failed schema validation",
        zodErrors: flattenError(serviceParsed.error),
      }),
    );
    return { kind: "internal-error", statusCode: 500, body: INTERNAL_BODY };
  }
  if (serviceParsed.data.ownerId !== params.ownerId) {
    // Same 404 envelope as genuine-not-found — never leak existence.
    return { kind: "not-found", statusCode: 404, body: NOT_FOUND_BODY };
  }

  // Step 2: most-recently-created Job via GSI1. GSI1SK = JOB#<createdAt>#<id>;
  // descending sort puts the newest first. Limit=1 — we only need the head.
  const jobResult = await docClient.send(
    new QueryCommand({
      TableName: params.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :svc",
      ExpressionAttributeValues: {
        ":svc": buildJobGSI1PK(params.serviceId),
      },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  if (!jobResult.Items || jobResult.Items.length === 0) {
    return {
      kind: "ok",
      statusCode: 200,
      body: { ok: true, data: { job: null } },
    };
  }

  const jobItem = jobResult.Items[0] as Record<string, unknown>;
  const jobParsed = JobSchema.safeParse(stripItemKeys(jobItem));
  if (!jobParsed.success) {
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "job item failed schema validation",
        zodErrors: flattenError(jobParsed.error),
      }),
    );
    return { kind: "internal-error", statusCode: 500, body: INTERNAL_BODY };
  }

  return {
    kind: "ok",
    statusCode: 200,
    body: { ok: true, data: { job: jobParsed.data } },
  };
};
