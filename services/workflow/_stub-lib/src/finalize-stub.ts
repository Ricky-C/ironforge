import {
  buildJobPK,
  buildServicePK,
  JOB_SK_META,
  SERVICE_SK_META,
  WorkflowExecutionInputSchema,
  type WorkflowExecutionInput,
} from "@ironforge/shared-types";
import {
  getTableName,
  transitionStatus,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
} from "@ironforge/shared-utils";

// finalize-stub: the terminal-success transition for the workflow.
// Reads run-terraform's output from $.steps.run-terraform (per
// state-machine.md ResultPath threading), writes Service.liveUrl and
// flips status provisioning → live, flips Job running → succeeded.
//
// Stub-vs-real: the real PR-C.9 finalize Lambda will do the same
// transitions but also emit a structured event for Phase-2 observability
// (audit log, customer notification). Stub omits those.

type FinalizeInput = WorkflowExecutionInput & {
  steps?: {
    "run-terraform"?: {
      live_url?: unknown;
      liveUrl?: unknown;
    };
    [stepName: string]: unknown;
  };
};

const STUB_LIVE_URL_FALLBACK = (input: WorkflowExecutionInput): string =>
  // run-terraform stub may or may not be invoked end-to-end during PR-C.2
  // exercises; falling back to the canonical subdomain shape lets
  // finalize succeed without a live run-terraform output. Real run-
  // terraform always emits live_url, so this fallback only triggers
  // in stub-end-to-end test runs.
  `https://${input.serviceName}.ironforge.rickycaballero.com`;

const inferLiveUrl = (event: FinalizeInput): string => {
  const tf = event.steps?.["run-terraform"];
  if (tf && typeof tf === "object") {
    const fromTf = (tf as { live_url?: unknown; liveUrl?: unknown }).live_url
      ?? (tf as { live_url?: unknown; liveUrl?: unknown }).liveUrl;
    if (typeof fromTf === "string" && fromTf.length > 0) {
      return fromTf;
    }
  }
  return STUB_LIVE_URL_FALLBACK(event);
};

export const finalizeStub = async (event: unknown): Promise<{ liveUrl: string }> => {
  // FinalizeInput extends WorkflowExecutionInput plus optional $.steps;
  // strip-validate the invariant portion, then read steps off the raw.
  const parsed = WorkflowExecutionInputSchema.safeParse(event);
  if (!parsed.success) {
    throw new Error(
      "finalize received malformed workflow input — see CloudWatch for the offending field",
    );
  }
  const input: FinalizeInput = { ...parsed.data, ...(event as object) };
  const tableName = getTableName();
  const stepName = "finalize" as const;
  const now = new Date().toISOString();

  await upsertJobStepRunning({
    tableName,
    jobId: input.jobId,
    stepName,
  });

  const liveUrl = inferLiveUrl(input);

  // Service: provisioning → live. Conditional protected on
  // currentJobId = :jobId so a stale finalize from a prior re-provision
  // can't overwrite a fresh provisioning's state.
  const serviceTransition = await transitionStatus({
    tableName,
    key: { PK: buildServicePK(input.serviceId), SK: SERVICE_SK_META },
    fromStatus: "provisioning",
    toStatus: "live",
    additionalUpdates: {
      currentJobId: null,
      liveUrl,
      provisionedAt: now,
      updatedAt: now,
    },
  });
  if (!serviceTransition.transitioned) {
    // Surface the actual current status in the thrown error so cleanup-
    // on-failure (if it runs) records the inconsistency.
    throw new Error(
      `finalize: Service status transition failed (current=${serviceTransition.currentStatus})`,
    );
  }

  // Job: running → succeeded.
  const jobTransition = await transitionStatus({
    tableName,
    key: { PK: buildJobPK(input.jobId), SK: JOB_SK_META },
    fromStatus: "running",
    toStatus: "succeeded",
    additionalUpdates: {
      completedAt: now,
      updatedAt: now,
    },
  });
  if (!jobTransition.transitioned) {
    throw new Error(
      `finalize: Job status transition failed (current=${jobTransition.currentStatus})`,
    );
  }

  await upsertJobStepSucceeded({
    tableName,
    jobId: input.jobId,
    stepName,
    output: { liveUrl },
  });

  return { liveUrl };
};
