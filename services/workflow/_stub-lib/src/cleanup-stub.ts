import {
  buildJobPK,
  buildServicePK,
  JOB_SK_META,
  SERVICE_SK_META,
  STEP_NAMES,
  WorkflowExecutionInputSchema,
  type StepName,
} from "@ironforge/shared-types";
import {
  getTableName,
  transitionStatus,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
} from "@ironforge/shared-utils";

// cleanup-on-failure-stub: the terminal-error transition for the
// workflow. Reads $.error (the Catch ResultPath) for SFN's failure
// summary, infers which step failed from $.steps, and writes:
//
//   1. JobStep#cleanup-on-failure running (idempotent)
//   2. Service: provisioning → failed (currentJobId cleared)
//   3. Job:     running → failed (failureReason + failedStep set)
//   4. JobStep#cleanup-on-failure succeeded
//
// PR-C.2 deliberately STOPS HERE — does NOT delete created AWS
// resources, GitHub repos, etc. See docs/tech-debt.md
// § "Cleanup-on-failure destroy chain" for the deferral rationale
// and the trigger checklist for re-introducing destroy semantics.
//
// The transitionStatus calls have ConditionExpressions that fail
// gracefully if the entity is already in the target state (e.g., a
// re-fired cleanup): the helper returns { transitioned: false,
// currentStatus: "failed" }, which is interpreted as idempotent
// success rather than an error.

type CleanupInput = {
  serviceId: string;
  jobId: string;
  serviceName: string;
  ownerId: string;
  templateId: string;
  inputs: Record<string, unknown>;
  executionName: string;
  error?: { Error?: unknown; Cause?: unknown };
  steps?: Record<string, unknown>;
};

const SANITIZED_FAILURE_REASON_FALLBACK = "Workflow failed; see JobStep entries for the originating step.";

// Infer which step failed by walking $.steps in declaration order. The
// last step that's PRESENT but NOT marked succeeded (or the step
// AFTER the last succeeded step) is the failed one. Stubs always
// succeed, so this code path is mostly aspirational for PR-C.2 — but
// it's important enough to land correctly so PR-C.3+ doesn't have to
// retrofit.
const STEP_ORDER: readonly StepName[] = STEP_NAMES.filter(
  (s) => s !== "cleanup-on-failure",
);

const inferFailedStep = (event: CleanupInput): string => {
  const steps = event.steps ?? {};
  // Walk in declaration order. The first step that's missing from
  // $.steps is where the workflow died (the prior step was the last
  // one that ran).
  let lastSeen: StepName | undefined;
  for (const step of STEP_ORDER) {
    if (step in steps) {
      lastSeen = step;
    } else {
      // Not yet executed — the prior step (lastSeen) succeeded; the
      // CURRENT step is the one that failed.
      return step;
    }
  }
  // All steps present in $.steps — anomalous; fall back to last-seen.
  return lastSeen ?? "unknown";
};

const sanitizeFailureReason = (event: CleanupInput): string => {
  // SFN's $.error.Cause is a JSON-stringified Lambda error report. It
  // can include stack traces and AWS resource ARNs. Per CLAUDE.md
  // error sanitization, we don't write the raw Cause to a customer-
  // visible field. Use a fixed fallback at the entity boundary;
  // detailed cause stays in the JobStep row's errorMessage for the
  // failed step (set by the failed Lambda before throwing).
  void event;
  return SANITIZED_FAILURE_REASON_FALLBACK;
};

export const cleanupStub = async (event: unknown): Promise<{ cleanedUp: true }> => {
  // We accept WorkflowExecutionInput PLUS optional $.error and $.steps
  // — Catch's ResultPath layered them onto the SFN state. Validate the
  // invariant prefix, then read the rest off the raw input.
  const parsed = WorkflowExecutionInputSchema.safeParse(event);
  if (!parsed.success) {
    throw new Error(
      "cleanup-on-failure received malformed workflow input — see CloudWatch for the offending field",
    );
  }
  const input: CleanupInput = { ...parsed.data, ...(event as object) };
  const tableName = getTableName();
  const stepName: StepName = "cleanup-on-failure";
  const now = new Date().toISOString();

  await upsertJobStepRunning({
    tableName,
    jobId: input.jobId,
    stepName,
  });

  const failedStep = inferFailedStep(input);
  const failureReason = sanitizeFailureReason(input);

  // Service: provisioning → failed. Idempotent on already-failed via
  // condition + currentStatus check below — re-fired cleanup is a no-op.
  // failedWorkflow="provisioning" tags this as a provisioning-side failure
  // (schema requires the field per ServiceFailedSchema); deprovisioning-
  // failures are written by their own terminal handler.
  const serviceResult = await transitionStatus({
    tableName,
    key: { PK: buildServicePK(input.serviceId), SK: SERVICE_SK_META },
    fromStatus: "provisioning",
    toStatus: "failed",
    additionalUpdates: {
      currentJobId: null,
      failureReason,
      failedAt: now,
      failedWorkflow: "provisioning",
      updatedAt: now,
    },
  });
  if (!serviceResult.transitioned && serviceResult.currentStatus !== "failed") {
    throw new Error(
      `cleanup-on-failure: Service in unexpected state (status=${serviceResult.currentStatus})`,
    );
  }

  // Job: running → failed. Same idempotency posture.
  const jobResult = await transitionStatus({
    tableName,
    key: { PK: buildJobPK(input.jobId), SK: JOB_SK_META },
    fromStatus: "running",
    toStatus: "failed",
    additionalUpdates: {
      failedStep,
      failureReason,
      failedAt: now,
      updatedAt: now,
    },
  });
  if (!jobResult.transitioned && jobResult.currentStatus !== "failed") {
    throw new Error(
      `cleanup-on-failure: Job in unexpected state (status=${jobResult.currentStatus})`,
    );
  }

  await upsertJobStepSucceeded({
    tableName,
    jobId: input.jobId,
    stepName,
    output: { failedStep },
  });

  return { cleanedUp: true };
};
