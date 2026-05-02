import { createHash, randomUUID } from "node:crypto";

import { StartExecutionCommand, ExecutionAlreadyExists } from "@aws-sdk/client-sfn";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildJobGSI1PK,
  buildJobGSI1SK,
  buildJobKeys,
  buildJobPK,
  buildServiceGSI1PK,
  buildServiceKeys,
  buildServicePK,
  CreateServiceRequestSchema,
  JOB_SK_META,
  SERVICE_SK_META,
  StaticSiteInputsSchema,
  TemplateIdSchema,
  type ApiFailure,
  type ApiSuccess,
  type CreateServiceRequest,
  type CreateServiceResponse,
  type Job,
  type Service,
  type TemplateId,
} from "@ironforge/shared-types";
import {
  docClient,
  sfnClient,
  withIdempotencyKey,
  type IdempotencyOutcome,
} from "@ironforge/shared-utils";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

// Two-stage validation pipeline + creation for POST /api/services.
// See state-machine.md and the PR-C.2 design conversation for the
// shape this consumes (CreateServiceRequestSchema + per-template
// InputsSchema lookup) and produces (Service + Job entities + SFN
// execution kicked off).

// Per-template inputs schemas. Adding a new template: add an entry
// here AND extend TEMPLATE_IDS in shared-types/src/service.ts AND
// land a templates/<id>/ironforge.yaml manifest.
const TEMPLATE_INPUTS_SCHEMAS: Record<TemplateId, z.ZodTypeAny> = {
  "static-site": StaticSiteInputsSchema,
};

// Convenience response builders. Inline-typed so TS narrows on `ok`.
const failure = (
  code: ApiFailure["error"]["code"],
  message: string,
): ApiFailure => ({ ok: false, error: { code, message } });

const INTERNAL_FAILURE = failure("INTERNAL", "internal server error");

type StatusedBody<T> = { statusCode: 200 | 201 | 400 | 409 | 500; body: T };

// -----------------------------------------------------------------------
// Stage 1 — envelope validation
// -----------------------------------------------------------------------
type EnvelopeResult =
  | { ok: true; request: CreateServiceRequest }
  | { ok: false; response: StatusedBody<ApiFailure> };

const validateEnvelope = (raw: unknown): EnvelopeResult => {
  const parsed = CreateServiceRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: {
        statusCode: 400,
        body: failure(
          "INVALID_REQUEST",
          "request body does not match the expected shape — see ApiError.code",
        ),
      },
    };
  }
  return { ok: true, request: parsed.data };
};

// -----------------------------------------------------------------------
// Stage 2 — per-template inputs validation
// -----------------------------------------------------------------------
type InputsResult =
  | { ok: true }
  | { ok: false; response: StatusedBody<ApiFailure> };

const validateTemplateInputs = (request: CreateServiceRequest): InputsResult => {
  // The envelope already validated templateId via TemplateIdSchema, so
  // a missing entry here is a wiring bug (registry mismatch), not a
  // user error. Surface as INTERNAL rather than UNKNOWN_TEMPLATE.
  const tidOk = TemplateIdSchema.safeParse(request.templateId);
  if (!tidOk.success) {
    return {
      ok: false,
      response: { statusCode: 400, body: failure("UNKNOWN_TEMPLATE", "templateId not recognized") },
    };
  }
  const schema = TEMPLATE_INPUTS_SCHEMAS[tidOk.data];
  if (!schema) {
    return {
      ok: false,
      response: { statusCode: 500, body: INTERNAL_FAILURE },
    };
  }
  const parsed = schema.safeParse(request.inputs);
  if (!parsed.success) {
    return {
      ok: false,
      response: {
        statusCode: 400,
        body: failure(
          "INVALID_INPUTS",
          "inputs failed template-specific validation",
        ),
      },
    };
  }
  return { ok: true };
};

// -----------------------------------------------------------------------
// Pre-check name collision (per-owner — sufficient for Phase 1 single-
// tenant; revisit when multi-tenancy lands per the deferral noted in
// docs/data-model.md). Race between this check and the write is
// theoretical at portfolio scale; production-grade global uniqueness
// would use a `NAME#<name>` reservation entity with TransactWriteItems.
// -----------------------------------------------------------------------
const checkNameAvailable = async (params: {
  tableName: string;
  ownerId: string;
  name: string;
}): Promise<boolean> => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: params.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :owner",
      FilterExpression: "#name = :name AND #status <> :archived",
      ExpressionAttributeNames: {
        "#name": "name",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":owner": buildServiceGSI1PK(params.ownerId),
        ":name": params.name,
        ":archived": "archived",
      },
      // We only need to know "is there one?" — Limit 1 short-circuits.
      Limit: 1,
    }),
  );
  return (result.Items ?? []).length === 0;
};

// -----------------------------------------------------------------------
// Idempotency hash. sha256(idempotencyKey + bodyHash + ownerId).
// scopeId on the IdempotencyRecord is ownerId so cross-tenant
// collision is impossible by construction (per
// feedback_idempotency_patterns.md).
// -----------------------------------------------------------------------
export const computeIdempotencyHash = (params: {
  idempotencyKey: string;
  body: unknown;
  ownerId: string;
}): string => {
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(params.body) ?? "")
    .digest("hex");
  return createHash("sha256")
    .update(params.idempotencyKey)
    .update(bodyHash)
    .update(params.ownerId)
    .digest("hex");
};

// -----------------------------------------------------------------------
// Core creation: TWI of Service + Job, then SFN StartExecution, then
// kickoff transitions. Returns a typed Service + Job in their post-
// kickoff state (status=provisioning + status=running).
// -----------------------------------------------------------------------
type ExecuteResult =
  | { ok: true; response: StatusedBody<ApiSuccess<CreateServiceResponse>> }
  | { ok: false; response: StatusedBody<ApiFailure> };

const executeCreation = async (params: {
  tableName: string;
  stateMachineArn: string;
  ownerId: string;
  request: CreateServiceRequest;
}): Promise<ExecuteResult> => {
  const { tableName, stateMachineArn, ownerId, request } = params;

  // ---------------------------------------------------------------------
  // Step 1 — pre-check name collision.
  // ---------------------------------------------------------------------
  const available = await checkNameAvailable({
    tableName,
    ownerId,
    name: request.name,
  });
  if (!available) {
    return {
      ok: false,
      response: {
        statusCode: 409,
        body: failure("CONFLICT", "service name already in use"),
      },
    };
  }

  // ---------------------------------------------------------------------
  // Step 2 — generate ids and build the entities.
  // ---------------------------------------------------------------------
  const serviceId = randomUUID();
  const jobId = randomUUID();
  const now = new Date().toISOString();

  const initialService: Service = {
    id: serviceId,
    name: request.name,
    ownerId,
    templateId: request.templateId,
    createdAt: now,
    updatedAt: now,
    inputs: request.inputs,
    currentJobId: null,
    status: "pending",
  };

  const initialJob: Job = {
    id: jobId,
    serviceId,
    ownerId,
    createdAt: now,
    updatedAt: now,
    status: "queued",
  };

  // ---------------------------------------------------------------------
  // Step 3 — TransactWriteItems: create both rows atomically with
  // attribute_not_exists guards. Fresh UUIDs make conditional failure
  // here a real bug (not a name collision), so we surface as INTERNAL.
  // ---------------------------------------------------------------------
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: { ...buildServiceKeys(initialService), ...initialService },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: { ...buildJobKeys(initialJob), ...initialJob },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ],
    }),
  );

  // ---------------------------------------------------------------------
  // Step 4 — SFN StartExecution. executionName = jobId for native
  // idempotency (SFN rejects duplicate names). ExecutionAlreadyExists
  // is treated as success — likely a retry of an in-flight request.
  // ---------------------------------------------------------------------
  let executionArn: string;
  try {
    const startResult = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: jobId,
        input: JSON.stringify({
          serviceId,
          jobId,
          executionName: jobId,
          serviceName: request.name,
          ownerId,
          templateId: request.templateId,
          inputs: request.inputs,
        }),
      }),
    );
    if (!startResult.executionArn) {
      // SDK invariant — StartExecution always returns the ARN on success.
      // Defensive throw to surface the unlikely shape mismatch.
      throw new Error("StartExecution returned no executionArn");
    }
    executionArn = startResult.executionArn;
  } catch (err) {
    if (err instanceof ExecutionAlreadyExists) {
      // The execution exists already — derive its ARN deterministically.
      // SFN execution ARNs follow stateMachineArn:executionName format.
      executionArn = `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${jobId}`;
    } else {
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Step 5 — kickoff transitions. Sequential UpdateItem calls (TWI
  // with conditions would also work; sequential keeps the error
  // attribution clean). The state-level Catch on every workflow state
  // routes to CleanupOnFailure, which re-enters and writes Service/Job
  // failed if these post-kickoff updates land but the workflow itself
  // can't proceed. So even partial-kickoff is recoverable downstream.
  // ---------------------------------------------------------------------
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: buildServicePK(serviceId), SK: SERVICE_SK_META },
      UpdateExpression:
        "SET #status = :provisioning, currentJobId = :jobId, updatedAt = :now",
      ConditionExpression:
        "#status = :pending AND attribute_type(currentJobId, :null)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":provisioning": "provisioning",
        ":pending": "pending",
        ":jobId": jobId,
        ":now": now,
        ":null": "NULL",
      },
    }),
  );

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
        // Set to validate-inputs since that's the first state in the
        // state machine. Keeps Job.currentStep accurate from t0.
        ":first": "validate-inputs",
      },
    }),
  );

  // ---------------------------------------------------------------------
  // Step 6 — build the response shape (post-kickoff state).
  // ---------------------------------------------------------------------
  const responseService: Service = {
    ...initialService,
    status: "provisioning",
    jobId,
    currentJobId: jobId,
    updatedAt: now,
  };
  const responseJob: Job = {
    ...initialJob,
    status: "running",
    startedAt: now,
    executionArn,
    currentStep: "validate-inputs",
    updatedAt: now,
  };

  return {
    ok: true,
    response: {
      statusCode: 201,
      body: {
        ok: true,
        data: { service: responseService, job: responseJob },
      },
    },
  };
};

// -----------------------------------------------------------------------
// Public entry point. Encapsulates the full pipeline. The route handler
// does HTTP-level concerns (header parsing, Hono response shaping) and
// delegates here.
// -----------------------------------------------------------------------
export type CreateServiceParams = {
  tableName: string;
  stateMachineArn: string;
  ownerId: string;
  body: unknown;
  idempotencyKey: string | undefined;
};

export type CreateServiceResult =
  | { kind: "first"; statusCode: number; body: unknown }
  | { kind: "replay"; statusCode: number; body: unknown }
  | { kind: "validation-error"; statusCode: number; body: ApiFailure }
  | { kind: "conflict"; statusCode: number; body: ApiFailure };

export const createService = async (
  params: CreateServiceParams,
): Promise<CreateServiceResult> => {
  // Stage 1.
  const envelope = validateEnvelope(params.body);
  if (!envelope.ok) {
    return {
      kind: "validation-error",
      statusCode: envelope.response.statusCode,
      body: envelope.response.body,
    };
  }

  // Stage 2.
  const inputs = validateTemplateInputs(envelope.request);
  if (!inputs.ok) {
    return {
      kind: "validation-error",
      statusCode: inputs.response.statusCode,
      body: inputs.response.body,
    };
  }

  const runCreation = async (): Promise<{
    statusCode: number;
    body: unknown;
    conflict: boolean;
  }> => {
    const result = await executeCreation({
      tableName: params.tableName,
      stateMachineArn: params.stateMachineArn,
      ownerId: params.ownerId,
      request: envelope.request,
    });
    return {
      statusCode: result.response.statusCode,
      body: result.response.body,
      conflict: !result.ok && result.response.statusCode === 409,
    };
  };

  if (params.idempotencyKey === undefined) {
    const direct = await runCreation();
    if (direct.conflict) {
      return {
        kind: "conflict",
        statusCode: direct.statusCode,
        body: direct.body as ApiFailure,
      };
    }
    return { kind: "first", statusCode: direct.statusCode, body: direct.body };
  }

  // Idempotency-Key path.
  const hash = computeIdempotencyHash({
    idempotencyKey: params.idempotencyKey,
    body: params.body,
    ownerId: params.ownerId,
  });

  const outcome: IdempotencyOutcome<unknown> = await withIdempotencyKey({
    tableName: params.tableName,
    hash,
    scopeId: params.ownerId,
    execute: async () => {
      const result = await runCreation();
      return { statusCode: result.statusCode, body: result.body };
    },
  });

  // 409 inside the cache-write attempt: still cache it (deterministic
  // outcome for the given input + scope), but report as conflict at the
  // route layer for proper status mapping.
  const isConflict =
    outcome.statusCode === 409 &&
    typeof outcome.body === "object" &&
    outcome.body !== null &&
    "ok" in outcome.body &&
    (outcome.body as { ok: boolean }).ok === false;

  if (isConflict) {
    return {
      kind: "conflict",
      statusCode: 409,
      body: outcome.body as ApiFailure,
    };
  }

  return {
    kind: outcome.kind,
    statusCode: outcome.statusCode,
    body: outcome.body,
  };
};

// Re-export for consumers (route handler + tests) that need to compute
// the deterministic GSI keys without re-deriving.
export const __internal = {
  buildServiceGSI1KeyTuple: (ownerId: string, createdAt: string, id: string) => ({
    GSI1PK: buildServiceGSI1PK(ownerId),
    GSI1SK: `SERVICE#${createdAt}#${id}`,
  }),
  buildJobGSI1KeyTuple: (serviceId: string, createdAt: string, id: string) => ({
    GSI1PK: buildJobGSI1PK(serviceId),
    GSI1SK: buildJobGSI1SK(createdAt, id),
  }),
};
