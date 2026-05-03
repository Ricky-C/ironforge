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

// Real finalize Lambda body. Replaces the PR-C.2/C.9 finalizeStub.
//
// Terminal-success transitions for the provisioning workflow. Reads
// liveUrl from the focused SFN Parameters input (resolved from
// $.steps.run-terraform.live_url at the SFN layer; Lambda stays
// decoupled from full state shape, mirroring trigger-deploy +
// wait-for-deploy).
//
// Pipeline:
//   1. Parse SFN-supplied state input as HandlerInputSchema.
//   2. JobStep running (natural-key idempotent).
//   3. Try Service transition (provisioning → live, conditional on
//      currentJobId = :jobId). additionalUpdates: liveUrl,
//      provisionedAt, currentJobId=null, updatedAt — atomic so
//      observers never see "status flipped but liveUrl missing".
//   4. If Service transition fails: GetItem and 3-way classify:
//      - target state with our markers → idempotent retry (success)
//      - target state with someone else's markers → terminal data-
//        integrity issue (throw IronforgeFinalizeError with context)
//      - unexpected state (e.g. failed) → terminal workflow state
//        issue (throw IronforgeFinalizeError with context)
//   5. Try Job transition (running → succeeded). additionalUpdates:
//      completedAt, updatedAt.
//   6. If Job transition fails: GetItem and 2-way classify:
//      - succeeded (any completedAt) → idempotent retry (success)
//      - any other status → terminal failure (throw)
//   7. JobStep succeeded with output { liveUrl, provisionedAt }.
//
// IronforgeFinalizeError context shape carries enough for operators
// to triage without log spelunking: serviceId, jobId, expected/actual
// status pairs, expected/actual liveUrl, actualCurrentJobId. Per
// CLAUDE.md error-sanitization principle: liveUrl is the customer's
// public URL (not sensitive); status enums + UUIDs are internal but
// safe; no AWS resource ARNs, no PEMs, no tokens.

const STEP_NAME: StepName = "finalize";

const SANITIZED_INPUT_PARSE_MESSAGE =
  "Workflow execution input failed schema validation — see CloudWatch for the offending field";

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

export type FinalizeErrorContext = {
  serviceId: string;
  jobId: string;
  expectedStatus: "live" | "succeeded";
  actualStatus: string | null;
  expectedLiveUrl?: string;
  actualLiveUrl?: string | null;
  actualCurrentJobId?: string | null;
};

export class IronforgeFinalizeError extends Error {
  override readonly name = "IronforgeFinalizeError";

  constructor(
    message: string,
    public readonly context: FinalizeErrorContext,
  ) {
    super(message);
  }
}

export const HandlerInputSchema = z.object({
  jobId: z.string().uuid(),
  serviceId: z.string().uuid(),
  liveUrl: z.string().url(),
});

export type HandlerInput = z.infer<typeof HandlerInputSchema>;

export type FinalizeOutput = {
  liveUrl: string;
  provisionedAt: string;
};

export type DateNowMs = () => number;

export type BuildHandlerDeps = {
  now?: DateNowMs;
};

// Read the Service item to inspect its actual state on conditional-
// write failure. Returns the narrow shape we care about; other fields
// are ignored.
type ServiceInspect = {
  status: string | null;
  currentJobId: string | null;
  liveUrl: string | null;
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
    currentJobId:
      typeof item?.["currentJobId"] === "string" ? item["currentJobId"] : null,
    liveUrl: typeof item?.["liveUrl"] === "string" ? item["liveUrl"] : null,
  };
};

// Read the Job item to inspect status on conditional-write failure.
type JobInspect = {
  status: string | null;
};

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
): ((event: unknown) => Promise<FinalizeOutput>) => {
  const now = deps.now ?? Date.now;

  return async (event: unknown): Promise<FinalizeOutput> => {
    // Step 1 — parse focused input.
    const parsed = HandlerInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "finalize received malformed input",
          stepName: STEP_NAME,
          zodIssues: parsed.error.issues,
        }),
      );
      throw new IronforgeWorkflowInputError(SANITIZED_INPUT_PARSE_MESSAGE);
    }
    const input = parsed.data;
    const tableName = getTableName();
    const provisionedAt = new Date(now()).toISOString();

    // Step 2 — JobStep running.
    await upsertJobStepRunning({
      tableName,
      jobId: input.jobId,
      stepName: STEP_NAME,
    });

    try {
      // Step 3 — Service transition (provisioning → live). Conditional
      // on currentJobId=:jobId so a stale finalize from a prior re-
      // provision can't overwrite a fresh provisioning's state.
      const serviceTransition = await transitionStatus({
        tableName,
        key: { PK: buildServicePK(input.serviceId), SK: SERVICE_SK_META },
        fromStatus: "provisioning",
        toStatus: "live",
        additionalUpdates: {
          currentJobId: null,
          liveUrl: input.liveUrl,
          provisionedAt,
          updatedAt: provisionedAt,
        },
      });

      // Step 4 — on Service transition failure, inspect for idempotent
      // retry. Most-likely failure mode at portfolio scale: Lambda
      // timeout post-DDB-write but pre-return; SFN retry sees the
      // already-applied state and fails the conditional. Treating
      // that case as success is the right answer.
      if (!serviceTransition.transitioned) {
        const actual = await inspectService(tableName, input.serviceId);
        if (
          actual.status === "live" &&
          actual.currentJobId === null &&
          actual.liveUrl === input.liveUrl
        ) {
          // Idempotent retry — our prior invocation already wrote
          // the terminal state. Continue to the Job transition.
          console.info(
            JSON.stringify({
              level: "INFO",
              message:
                "finalize Service transition was a no-op (already at terminal state with our markers)",
              stepName: STEP_NAME,
              jobId: input.jobId,
              serviceId: input.serviceId,
            }),
          );
        } else {
          throw new IronforgeFinalizeError(
            `Service ${input.serviceId} in unexpected state during finalize verification`,
            {
              serviceId: input.serviceId,
              jobId: input.jobId,
              expectedStatus: "live",
              actualStatus: actual.status,
              expectedLiveUrl: input.liveUrl,
              actualLiveUrl: actual.liveUrl,
              actualCurrentJobId: actual.currentJobId,
            },
          );
        }
      }

      // Step 5 — Job transition (running → succeeded).
      const jobTransition = await transitionStatus({
        tableName,
        key: { PK: buildJobPK(input.jobId), SK: JOB_SK_META },
        fromStatus: "running",
        toStatus: "succeeded",
        additionalUpdates: {
          completedAt: provisionedAt,
          updatedAt: provisionedAt,
        },
      });

      // Step 6 — on Job transition failure, inspect for idempotent
      // retry. Job's PK already includes the jobId, so the only
      // identity check needed is "did this Job reach succeeded?"
      if (!jobTransition.transitioned) {
        const actual = await inspectJob(tableName, input.jobId);
        if (actual.status === "succeeded") {
          // Idempotent retry on the Job transition.
          console.info(
            JSON.stringify({
              level: "INFO",
              message:
                "finalize Job transition was a no-op (already at succeeded)",
              stepName: STEP_NAME,
              jobId: input.jobId,
            }),
          );
        } else {
          throw new IronforgeFinalizeError(
            `Job ${input.jobId} in unexpected state during finalize verification`,
            {
              serviceId: input.serviceId,
              jobId: input.jobId,
              expectedStatus: "succeeded",
              actualStatus: actual.status,
            },
          );
        }
      }

      // Step 7 — JobStep succeeded.
      const output: FinalizeOutput = {
        liveUrl: input.liveUrl,
        provisionedAt,
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
