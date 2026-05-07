import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildJobPK,
  buildJobStepPK,
  buildServicePK,
  JobStepSchema,
  SERVICE_SK_META,
  ServiceSchema,
  type ApiFailure,
  type ApiSuccess,
  type JobStep,
} from "@ironforge/shared-types";
import { docClient } from "@ironforge/shared-utils";
import { flattenError } from "zod";

// GET /api/services/:id/jobs/:jobId/steps — returns JobStep[] for the
// given Job (Query base table with PK=JOB#<jobId>, SK begins_with STEP#).
// At most ~12 entries per Job; no pagination needed.
//
// Authorization model:
//   - 404 NOT_FOUND when the Service doesn't exist or isn't owned.
//   - 404 NOT_FOUND when the Job exists but does not belong to the
//     given Service. Same envelope as not-owned — we don't leak
//     existence by status code.
//
// The Service-then-Job ownership chain costs 2 extra GETs versus
// reading Job.ownerId directly, but enforces "Job is reachable through
// THIS Service's URL" rather than "Job belongs to the same owner."
// Different services owned by the same user must not cross-link via
// the polling URL.

type ListJobStepsResponseData = { items: JobStep[] };

export type ListJobStepsParams = {
  tableName: string;
  serviceId: string;
  jobId: string;
  ownerId: string;
};

export type ListJobStepsResult =
  | { kind: "ok"; statusCode: 200; body: ApiSuccess<ListJobStepsResponseData> }
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

export const listJobSteps = async (
  params: ListJobStepsParams,
): Promise<ListJobStepsResult> => {
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
    return { kind: "not-found", statusCode: 404, body: NOT_FOUND_BODY };
  }

  // Step 2: verify the Job belongs to this Service. Reads the Job META
  // row and checks Job.serviceId. Without this, the URL
  // /services/<svcA>/jobs/<jobOfSvcB>/steps would return svcB's steps
  // through svcA's URL — not exploitable across owners (the prior check
  // covers that), but still a misnamed-URL bug worth catching.
  const jobResult = await docClient.send(
    new GetCommand({
      TableName: params.tableName,
      Key: { PK: buildJobPK(params.jobId), SK: "META" },
    }),
  );
  if (!jobResult.Item) {
    return { kind: "not-found", statusCode: 404, body: NOT_FOUND_BODY };
  }
  const jobItem = jobResult.Item as Record<string, unknown>;
  if (jobItem["serviceId"] !== params.serviceId) {
    return { kind: "not-found", statusCode: 404, body: NOT_FOUND_BODY };
  }

  // Step 3: query the JobStep entries.
  const stepsResult = await docClient.send(
    new QueryCommand({
      TableName: params.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :stepPrefix)",
      ExpressionAttributeValues: {
        ":pk": buildJobStepPK(params.jobId),
        ":stepPrefix": "STEP#",
      },
    }),
  );

  const items: JobStep[] = [];
  for (const raw of stepsResult.Items ?? []) {
    const parsed = JobStepSchema.safeParse(stripItemKeys(raw as Record<string, unknown>));
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "job step item failed schema validation",
          zodErrors: flattenError(parsed.error),
        }),
      );
      return { kind: "internal-error", statusCode: 500, body: INTERNAL_BODY };
    }
    items.push(parsed.data);
  }

  return {
    kind: "ok",
    statusCode: 200,
    body: { ok: true, data: { items } },
  };
};
