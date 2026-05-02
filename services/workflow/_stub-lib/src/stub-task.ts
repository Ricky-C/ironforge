import {
  WorkflowExecutionInputSchema,
  type StepName,
  type WorkflowExecutionInput,
} from "@ironforge/shared-types";
import {
  getTableName,
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
} from "@ironforge/shared-utils";

// Generic stub-task wrapper for the 6 task Lambdas that don't need
// terminal Service/Job transitions (validate-inputs, create-repo,
// generate-code, run-terraform, wait-for-cloudfront, trigger-deploy).
//
// Each invocation does:
//
//   1. Parse the SFN-supplied state input as WorkflowExecutionInput.
//      A schema mismatch is a wiring bug — surface as a custom-named
//      error so SFN's Catch routes to CleanupOnFailure (no retry).
//   2. Upsert JobStep <stepName> running (natural-key, idempotent).
//   3. Compute the stub output via the caller-supplied buildOutput.
//   4. Upsert JobStep <stepName> succeeded with the output.
//   5. Return the output as the SFN state's result.
//
// Real Lambdas in PR-C.3+ replace this wrapper but keep the same
// JobStep upsert shape (per docs/data-model.md write contract).

type StubTaskParams<TOutput extends Record<string, unknown>> = {
  stepName: StepName;
  buildOutput: (event: WorkflowExecutionInput) => TOutput;
};

class IronforgeStubInputError extends Error {
  override readonly name = "IronforgeStubInputError";
}

const SANITIZED_INPUT_ERROR_MESSAGE =
  "Workflow execution input failed schema validation — see CloudWatch for the offending field";

export const stubTask = <TOutput extends Record<string, unknown>>(
  params: StubTaskParams<TOutput>,
): ((event: unknown) => Promise<TOutput>) => {
  return async (event: unknown): Promise<TOutput> => {
    const parsed = WorkflowExecutionInputSchema.safeParse(event);
    if (!parsed.success) {
      // Don't leak the user's inputs / schema details into the thrown
      // error message — that gets persisted on JobStep.errorMessage and
      // surfaces to operators. CloudWatch holds the parse-failure
      // detail. CLAUDE.md error sanitization.
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "stubTask input parse failure",
          stepName: params.stepName,
          zodIssues: parsed.error.issues,
        }),
      );
      throw new IronforgeStubInputError(SANITIZED_INPUT_ERROR_MESSAGE);
    }

    const input = parsed.data;
    const tableName = getTableName();

    await upsertJobStepRunning({
      tableName,
      jobId: input.jobId,
      stepName: params.stepName,
    });

    let output: TOutput;
    try {
      output = params.buildOutput(input);
    } catch (err) {
      const errorName = err instanceof Error ? err.name : "Unknown";
      const errorMessage =
        err instanceof Error ? err.message : "stubTask buildOutput threw a non-Error";
      // buildOutput failure is a programmer error in stub code; mark
      // not-retryable so SFN's Retry block doesn't loop.
      await upsertJobStepFailed({
        tableName,
        jobId: input.jobId,
        stepName: params.stepName,
        errorName,
        errorMessage,
        retryable: false,
      });
      throw err;
    }

    await upsertJobStepSucceeded({
      tableName,
      jobId: input.jobId,
      stepName: params.stepName,
      output,
    });

    return output;
  };
};
