import { randomUUID } from "node:crypto";

import { ExecutionAlreadyExists, StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  buildJobKeys,
  buildJobPK,
  buildServicePK,
  JOB_SK_META,
  SERVICE_SK_META,
  ServiceSchema,
  type ApiError,
  type ApiFailure,
  type ApiSuccess,
  type Job,
  type Service,
} from "@ironforge/shared-types";
import { docClient, sfnClient } from "@ironforge/shared-utils";
import { flattenError } from "zod";

// DELETE /api/services/:id pipeline. Mirrors create-service.ts's shape:
// status guards → entity creation → SFN StartExecution → kickoff transitions.
//
// Status decisions:
//   - pending / provisioning  → 409 SERVICE_IN_FLIGHT (provisioning still
//                               running; cancellation is Phase 2+)
//   - live / failed           → kickoff deprovisioning (this is the work)
//   - deprovisioning          → 202 with the existing in-flight Job
//                               (idempotent re-DELETE returns same job)
//   - archived                → 404 NOT_FOUND (don't leak existence)
//   - not-found / not-owned   → 404 NOT_FOUND (same envelope per the
//                               authorization model in docs/data-model.md)
//
// Status-vs-failedWorkflow note: a Service in `failed` status MAY have
// failedWorkflow="deprovisioning" (a prior deprovisioning attempt that
// failed). Re-DELETE on it is the recovery path — destroy chain is
// idempotent (404/NoSuchKey treated as succeeded), so retrying is safe.

// Strips DynamoDB single-table key attributes from an unmarshalled item
// so the remainder validates cleanly against ServiceSchema. Mirrors the
// same helper in routes/services.ts.
const stripServiceItemKeys = (item: Record<string, unknown>): Record<string, unknown> => {
  const result = { ...item };
  delete result["PK"];
  delete result["SK"];
  delete result["GSI1PK"];
  delete result["GSI1SK"];
  return result;
};

const failure = (
  code: ApiError["code"],
  message: string,
  extra: Partial<Pick<ApiError, "currentState">> = {},
): ApiFailure => ({
  ok: false,
  error: { code, message, ...extra },
});

export type DeprovisionServiceResponse = {
  service: Service;
  job: Job;
};

export type DeprovisionServiceParams = {
  tableName: string;
  deprovisioningStateMachineArn: string;
  ownerId: string;
  serviceId: string;
};

export type DeprovisionServiceResult =
  | {
      kind: "kickoff" | "in-flight-existing";
      statusCode: 202;
      body: ApiSuccess<DeprovisionServiceResponse>;
    }
  | { kind: "in-flight-rejection"; statusCode: 409; body: ApiFailure }
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

// -----------------------------------------------------------------------
// Read + parse the Service. Returns the typed Service, a 404 for
// missing/not-owned/archived, or an internal error for parse failures.
// -----------------------------------------------------------------------

type ServiceLookupResult =
  | { ok: true; service: Service }
  | { ok: false; result: DeprovisionServiceResult };

const lookupService = async (params: {
  tableName: string;
  serviceId: string;
  ownerId: string;
}): Promise<ServiceLookupResult> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: params.tableName,
      Key: { PK: buildServicePK(params.serviceId), SK: SERVICE_SK_META },
    }),
  );
  if (!result.Item) {
    // Genuine 404.
    return {
      ok: false,
      result: { kind: "not-found", statusCode: 404, body: NOT_FOUND_BODY },
    };
  }

  const stripped = stripServiceItemKeys(result.Item as Record<string, unknown>);
  const parsed = ServiceSchema.safeParse(stripped);
  if (!parsed.success) {
    // Schema violation on a stored row → 500. Caller logs structured
    // detail. Same fail-loud posture as routes/services.ts.
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "service item failed schema validation",
        zodErrors: flattenError(parsed.error),
      }),
    );
    return {
      ok: false,
      result: { kind: "internal-error", statusCode: 500, body: INTERNAL_BODY },
    };
  }
  const service = parsed.data;

  // Ownership check. Same 404 envelope as the genuine-not-found case —
  // never leak existence via response shape.
  if (service.ownerId !== params.ownerId) {
    return {
      ok: false,
      result: { kind: "not-found", statusCode: 404, body: NOT_FOUND_BODY },
    };
  }

  // Archived services are tombstones for DELETE purposes — return 404
  // so callers can't distinguish "you already deleted this" from "this
  // never existed."
  if (service.status === "archived") {
    return {
      ok: false,
      result: { kind: "not-found", statusCode: 404, body: NOT_FOUND_BODY },
    };
  }

  return { ok: true, service };
};

// -----------------------------------------------------------------------
// Read the in-flight deprovisioning Job and return both as the response.
// -----------------------------------------------------------------------

const readInFlightJob = async (params: {
  tableName: string;
  jobId: string;
}): Promise<Job | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: params.tableName,
      Key: { PK: buildJobPK(params.jobId), SK: JOB_SK_META },
    }),
  );
  if (!result.Item) return null;
  // Job parse — caller falls back to internal-error if this fails.
  // The in-flight branch only runs when Service.status === "deprovisioning"
  // and we trust the workflow's writes; defensive parse is not added here.
  return result.Item as unknown as Job;
};

// -----------------------------------------------------------------------
// Kickoff: create Job, transact-write Service.deprovisioning + Job, fire
// SFN, then transition Job queued → running with the executionArn.
// -----------------------------------------------------------------------

const executeKickoff = async (params: {
  tableName: string;
  deprovisioningStateMachineArn: string;
  service: Service;
  ownerId: string;
}): Promise<DeprovisionServiceResult> => {
  const { tableName, deprovisioningStateMachineArn, service, ownerId } = params;

  const jobId = randomUUID();
  const now = new Date().toISOString();

  const initialJob: Job = {
    id: jobId,
    serviceId: service.id,
    ownerId,
    createdAt: now,
    updatedAt: now,
    status: "queued",
  };

  // TransactWriteItems — atomic Job.create + Service kickoff transition.
  // Service condition: status IN (live, failed) AND currentJobId == null.
  // Both `currentJobId` (operational pointer) and `jobId` (schema-required
  // snapshot for the deprovisioning variant) are set in the same write,
  // mirroring the create-service.ts kickoff post-PR-5a fix.
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: { ...buildJobKeys(initialJob), ...initialJob },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: { PK: buildServicePK(service.id), SK: SERVICE_SK_META },
            UpdateExpression:
              "SET #status = :deprovisioning, currentJobId = :jobId, jobId = :jobId, updatedAt = :now",
            // Status guard: only allow kickoff from a terminal state with
            // no active Job. Re-DELETE during the in-flight window is
            // handled by the upstream status switch (returns existing Job),
            // so this condition failing here = race with another DELETE.
            ConditionExpression:
              "(#status = :live OR #status = :failed) AND attribute_type(currentJobId, :null)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":deprovisioning": "deprovisioning",
              ":live": "live",
              ":failed": "failed",
              ":jobId": jobId,
              ":now": now,
              ":null": "NULL",
            },
          },
        },
      ],
    }),
  );

  // SFN StartExecution. executionName = jobId for native idempotency
  // (SFN rejects duplicate names → ExecutionAlreadyExists treated as a
  // retry of an in-flight request, not an error).
  let executionArn: string;
  try {
    const startResult = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: deprovisioningStateMachineArn,
        name: jobId,
        input: JSON.stringify({
          serviceId: service.id,
          jobId,
          executionName: jobId,
          serviceName: service.name,
          ownerId,
          templateId: service.templateId,
          inputs: service.inputs,
        }),
      }),
    );
    if (!startResult.executionArn) {
      throw new Error("StartExecution returned no executionArn");
    }
    executionArn = startResult.executionArn;
  } catch (err) {
    if (err instanceof ExecutionAlreadyExists) {
      executionArn = `${deprovisioningStateMachineArn.replace(
        ":stateMachine:",
        ":execution:",
      )}:${jobId}`;
    } else {
      throw err;
    }
  }

  // Job: queued → running. The state-level Catch on every state of the
  // deprovisioning workflow routes to DeprovisionFailed, which writes
  // Job.status = failed if the workflow itself can't proceed. Partial
  // kickoff (Job stays queued) is recoverable downstream.
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: buildJobPK(jobId), SK: JOB_SK_META },
      UpdateExpression:
        "SET #status = :running, startedAt = :now, executionArn = :arn, currentStep = :first, updatedAt = :now",
      ConditionExpression: "#status = :queued",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":running": "running",
        ":queued": "queued",
        ":now": now,
        ":arn": executionArn,
        // First state of the deprovisioning state machine. InitDeprovision-
        // Steps is a Pass state that doesn't carry a JobStep — the first
        // task state is DeprovisionTerraform.
        ":first": "deprovision-terraform",
      },
    }),
  );

  const responseService: Service = {
    id: service.id,
    name: service.name,
    ownerId: service.ownerId,
    templateId: service.templateId,
    createdAt: service.createdAt,
    updatedAt: now,
    inputs: service.inputs,
    currentJobId: jobId,
    status: "deprovisioning",
    jobId,
  };
  const responseJob: Job = {
    ...initialJob,
    status: "running",
    startedAt: now,
    executionArn,
    currentStep: "deprovision-terraform",
    updatedAt: now,
  };

  return {
    kind: "kickoff",
    statusCode: 202,
    body: { ok: true, data: { service: responseService, job: responseJob } },
  };
};

// -----------------------------------------------------------------------
// Public entry point.
// -----------------------------------------------------------------------

export const deprovisionService = async (
  params: DeprovisionServiceParams,
): Promise<DeprovisionServiceResult> => {
  const lookup = await lookupService({
    tableName: params.tableName,
    serviceId: params.serviceId,
    ownerId: params.ownerId,
  });
  if (!lookup.ok) return lookup.result;

  const service = lookup.service;

  switch (service.status) {
    case "pending":
    case "provisioning": {
      // Provisioning workflow in-flight; can't deprovision until
      // terminal state. Phase 2 may add cancellation; Phase 1.5 rejects.
      return {
        kind: "in-flight-rejection",
        statusCode: 409,
        body: failure(
          "SERVICE_IN_FLIGHT",
          "Service is currently provisioning. DELETE is not available until the service reaches a terminal state.",
          { currentState: service.status },
        ),
      };
    }
    case "deprovisioning": {
      // Idempotent re-DELETE — return the in-flight Job rather than
      // kicking off a duplicate. SFN's executionName=jobId guard would
      // reject the second StartExecution anyway, but reading the
      // existing Job gives the caller the response shape they expect.
      const job = await readInFlightJob({
        tableName: params.tableName,
        jobId: service.jobId,
      });
      if (!job) {
        // Service points at a Job that doesn't exist — data integrity
        // problem. Surface as 500 so operators can investigate.
        console.error(
          JSON.stringify({
            level: "ERROR",
            message:
              "Service.status=deprovisioning but currentJobId points at a missing Job",
            serviceId: service.id,
            jobId: service.jobId,
          }),
        );
        return {
          kind: "internal-error",
          statusCode: 500,
          body: INTERNAL_BODY,
        };
      }
      return {
        kind: "in-flight-existing",
        statusCode: 202,
        body: { ok: true, data: { service, job } },
      };
    }
    case "live":
    case "failed": {
      return executeKickoff({
        tableName: params.tableName,
        deprovisioningStateMachineArn: params.deprovisioningStateMachineArn,
        service,
        ownerId: params.ownerId,
      });
    }
    case "archived": {
      // Already 404'd in lookupService. The case branch is here for
      // exhaustiveness — if Service ever gains a new status variant the
      // switch-exhaustiveness check (when enabled per docs/tech-debt.md
      // § "Enforce discriminated-union exhaustiveness") will surface
      // the missing branch here at compile time.
      return { kind: "not-found", statusCode: 404, body: NOT_FOUND_BODY };
    }
    default: {
      // Same forward-compat exhaustiveness guard. TS narrows `service`
      // to `never` here when SERVICE_STATUSES is fully covered above.
      const _exhaustive: never = service;
      void _exhaustive;
      return { kind: "internal-error", statusCode: 500, body: INTERNAL_BODY };
    }
  }
};
