import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildJobPK,
  buildServicePK,
  JOB_SK_META,
  SERVICE_SK_META,
  type StepName,
} from "@ironforge/shared-types";
import {
  docClient,
  getTableName,
  transitionStatus,
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
} from "@ironforge/shared-utils";
import { z } from "zod";

// deprovision-failed: Phase 1.5 deprovisioning SFN terminal-failure
// handler. Reached when DeprovisionTerraform (State 1) or
// DeleteExternalResources (State 2) catches an error and routes here.
//
// Pipeline:
//   1. Parse focused input.
//   2. JobStep#deprovision-failed running upsert.
//   3. Service: deprovisioning → failed
//      (failedWorkflow="deprovisioning", failureReason, failedAt,
//      currentJobId=null). Idempotent on already-failed.
//   4. Job: running → failed (failureReason, failedStep set —
//      failedStep inferred from $.steps presence). Idempotent on
//      already-failed.
//   5. JobStep#deprovision-failed succeeded.
//
// CRITICAL DESIGN DECISION — does NOT re-run the destroy chain.
//
// Unlike cleanup-on-failure (which runs the destroy chain to undo
// partial provisioning), this Lambda only records the failed state in
// DDB. Re-running the destroy chain on a failed deprovisioning attempt
// could:
//   - Mask the original failure (a destroy that succeeded the second
//     time hides why it failed the first).
//   - Hit inconsistent partial-destroy state (some resources gone,
//     others not — re-attempting may surface different errors than
//     the originating one and confuse triage).
//
// Recovery is operator-driven: failed deprovisioning attempts surface
// as Service.status === "failed" with failedWorkflow === "deprovisioning".
// The user re-issues DELETE → deprovisioning SFN runs again with all
// destroy-chain primitives idempotent (404 / NoSuchKey treated as
// success), so retry is safe.

const STEP_NAME: StepName = "deprovision-failed";

const SANITIZED_INPUT_PARSE_MESSAGE =
  "deprovision-failed received malformed workflow input — see CloudWatch for the offending field";

const SANITIZED_FAILURE_REASON_FALLBACK =
  "Deprovisioning workflow failed; see JobStep entries for the originating step.";

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

class IronforgeDeprovisionFailedHandlerError extends Error {
  override readonly name = "IronforgeDeprovisionFailedHandlerError";

  constructor(
    message: string,
    public readonly context: Record<string, unknown>,
  ) {
    super(message);
  }
}

export {
  IronforgeWorkflowInputError,
  IronforgeDeprovisionFailedHandlerError,
};

// Focused input. The SFN routes here from a Catch on either State 1
// or State 2; the original event flows through plus $.error and
// $.steps populated by ResultPath threading.
export const HandlerInputSchema = z.object({
  jobId: z.string().uuid(),
  serviceId: z.string().uuid(),
  // $.steps tracks which states have completed before failure.
  // Optional because State 1's catch fires before any step has been
  // recorded. Each entry's shape is opaque at this Lambda.
  steps: z.record(z.string(), z.unknown()).optional(),
  // $.error from SFN's Catch ResultPath. Sanitized at the entity
  // boundary — never written verbatim to a customer-visible field.
  error: z
    .object({
      Error: z.unknown().optional(),
      Cause: z.unknown().optional(),
    })
    .optional(),
});

export type HandlerInput = z.infer<typeof HandlerInputSchema>;

export type DeprovisionFailedOutput = {
  failedStep: string;
  failedAt: string;
};

export type DateNowMs = () => number;

export type BuildHandlerDeps = {
  now?: DateNowMs;
};

// Two happy states in declaration order. The failed step is the FIRST
// one missing from $.steps (i.e., the one that didn't complete).
const DEPROVISION_STEP_ORDER = [
  "deprovision-terraform",
  "deprovision-external-resources",
] as const;

const inferFailedStep = (steps: Record<string, unknown> | undefined): string => {
  const present = steps ?? {};
  let lastSeen: string | undefined;
  for (const step of DEPROVISION_STEP_ORDER) {
    if (step in present) {
      lastSeen = step;
    } else {
      // The first absent step is where the workflow died.
      return step;
    }
  }
  // All steps present (anomalous — we wouldn't have routed here if both
  // succeeded). Fall back to the last-seen for triage.
  return lastSeen ?? "unknown";
};

const sanitizeFailureReason = (_input: HandlerInput): string => {
  // Per CLAUDE.md error sanitization: SFN's $.error.Cause is a
  // JSON-stringified Lambda error report that can include stack traces
  // and AWS resource ARNs. Don't write the raw Cause to a customer-
  // visible field. Detailed cause stays in the JobStep row's
  // errorMessage for the failed step (set by the failed Lambda
  // before throwing).
  return SANITIZED_FAILURE_REASON_FALLBACK;
};

type ServiceInspect = {
  status: string | null;
};

const inspectService = async (
  tableName: string,
  serviceId: string,
): Promise<ServiceInspect> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: buildServicePK(serviceId), SK: SERVICE_SK_META },
    }),
  );
  const item = result.Item;
  return {
    status: typeof item?.["status"] === "string" ? item["status"] : null,
  };
};

type JobInspect = { status: string | null };

const inspectJob = async (
  tableName: string,
  jobId: string,
): Promise<JobInspect> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { PK: buildJobPK(jobId), SK: JOB_SK_META },
    }),
  );
  const item = result.Item;
  return {
    status: typeof item?.["status"] === "string" ? item["status"] : null,
  };
};

export const buildHandler = (
  deps: BuildHandlerDeps = {},
): ((event: unknown) => Promise<DeprovisionFailedOutput>) => {
  const now = deps.now ?? Date.now;

  return async (event: unknown): Promise<DeprovisionFailedOutput> => {
    // Step 1 — parse focused input.
    const parsed = HandlerInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "deprovision-failed received malformed input",
          stepName: STEP_NAME,
          zodIssues: parsed.error.issues,
        }),
      );
      throw new IronforgeWorkflowInputError(SANITIZED_INPUT_PARSE_MESSAGE);
    }
    const input = parsed.data;
    const tableName = getTableName();
    const failedAt = new Date(now()).toISOString();

    // Step 2 — JobStep running.
    await upsertJobStepRunning({
      tableName,
      jobId: input.jobId,
      stepName: STEP_NAME,
    });

    try {
      const failedStep = inferFailedStep(input.steps);
      const failureReason = sanitizeFailureReason(input);

      // Step 3 — Service: deprovisioning → failed. Idempotent on
      // already-failed via the post-conditional GetItem inspect.
      const serviceTransition = await transitionStatus({
        tableName,
        key: { PK: buildServicePK(input.serviceId), SK: SERVICE_SK_META },
        fromStatus: "deprovisioning",
        toStatus: "failed",
        additionalUpdates: {
          currentJobId: null,
          failureReason,
          failedAt,
          failedWorkflow: "deprovisioning",
          updatedAt: failedAt,
        },
      });

      if (!serviceTransition.transitioned) {
        const actual = await inspectService(tableName, input.serviceId);
        if (actual.status === "failed") {
          // Idempotent retry — already-failed is a no-op success.
          console.info(
            JSON.stringify({
              level: "INFO",
              message:
                "deprovision-failed Service transition was a no-op (already failed)",
              stepName: STEP_NAME,
              jobId: input.jobId,
              serviceId: input.serviceId,
            }),
          );
        } else {
          throw new IronforgeDeprovisionFailedHandlerError(
            `Service ${input.serviceId} in unexpected state during deprovision-failure transition`,
            {
              phase: "transitionService",
              serviceId: input.serviceId,
              jobId: input.jobId,
              expectedStatus: "failed",
              actualStatus: actual.status,
            },
          );
        }
      }

      // Step 4 — Job: running → failed. Idempotent on already-failed.
      const jobTransition = await transitionStatus({
        tableName,
        key: { PK: buildJobPK(input.jobId), SK: JOB_SK_META },
        fromStatus: "running",
        toStatus: "failed",
        additionalUpdates: {
          failedStep,
          failureReason,
          failedAt,
          updatedAt: failedAt,
        },
      });

      if (!jobTransition.transitioned) {
        const actual = await inspectJob(tableName, input.jobId);
        if (actual.status === "failed") {
          console.info(
            JSON.stringify({
              level: "INFO",
              message:
                "deprovision-failed Job transition was a no-op (already failed)",
              stepName: STEP_NAME,
              jobId: input.jobId,
            }),
          );
        } else {
          throw new IronforgeDeprovisionFailedHandlerError(
            `Job ${input.jobId} in unexpected state during deprovision-failure transition`,
            {
              phase: "transitionJob",
              serviceId: input.serviceId,
              jobId: input.jobId,
              expectedStatus: "failed",
              actualStatus: actual.status,
            },
          );
        }
      }

      // Step 5 — JobStep succeeded.
      const output: DeprovisionFailedOutput = {
        failedStep,
        failedAt,
      };
      await upsertJobStepSucceeded({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
        output,
      });
      return output;
    } catch (err) {
      const errorName = err instanceof Error ? err.name : "Unknown";
      const errorMessage = err instanceof Error ? err.message : String(err);
      await upsertJobStepFailed({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
        errorName,
        errorMessage,
        retryable: false,
      });
      throw err;
    }
  };
};
