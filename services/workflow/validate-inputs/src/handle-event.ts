import {
  getInputsSchema,
  TemplateIdSchema,
  WorkflowExecutionInputSchema,
  type IronforgeManifest,
  type StepName,
} from "@ironforge/shared-types";
import {
  getTableName,
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
} from "@ironforge/shared-utils";

// Real validate-inputs Lambda body. Replaces the PR-C.2 stub
// (services/workflow/_stub-lib/src/stub-task.ts).
//
// Pipeline:
//   1. Parse the SFN-supplied state input as WorkflowExecutionInput.
//      Schema mismatch is a wiring bug — surface as a custom-named
//      error so SFN's Catch routes to CleanupOnFailure (Retry block
//      excludes custom error names by name; see docs/state-machine.md).
//   2. upsertJobStepRunning("validate-inputs"). Natural-key idempotent.
//   3. Resolve templateId → per-template inputs schema via the bundled
//      manifest's id and the TEMPLATE_REGISTRY in shared-types.
//   4. Apply the per-template schema to event.inputs. On failure, write
//      JobStep failed (retryable: false) and throw IronforgeValidationError.
//   5. upsertJobStepSucceeded with output { valid, templateId, validatedAt }.
//
// The handler is constructed via buildHandler so tests can inject an
// arbitrary IronforgeManifest without exercising the YAML-bundling
// path. The Lambda entry point in handler.ts wires the real bundled
// manifest into the factory.

const STEP_NAME: StepName = "validate-inputs";

// Custom error names — match the docs/state-machine.md error-class
// taxonomy. The state-level Retry block excludes these by name so a
// validation failure / wiring bug doesn't get auto-retried.
class IronforgeValidationError extends Error {
  override readonly name = "IronforgeValidationError";
}

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

class IronforgeTemplateMismatchError extends Error {
  override readonly name = "IronforgeTemplateMismatchError";
}

// Sanitized error messages — JobStep.errorMessage is operator-facing
// (and may eventually surface to users via Service.failureReason).
// Detail goes to CloudWatch via console.error; never inline in throws.
const SANITIZED_INPUT_PARSE_MESSAGE =
  "Workflow execution input failed schema validation — see CloudWatch for the offending field";
const SANITIZED_TEMPLATE_MISMATCH_MESSAGE =
  "Workflow templateId does not match the manifest bundled with this Lambda";
const SANITIZED_VALIDATION_FAILURE_MESSAGE =
  "Template inputs failed per-template validation — see CloudWatch for the offending field";

export type ValidateInputsOutput = {
  valid: true;
  templateId: string;
  validatedAt: string;
};

export const buildHandler = (
  manifest: IronforgeManifest,
): ((event: unknown) => Promise<ValidateInputsOutput>) => {
  return async (event: unknown): Promise<ValidateInputsOutput> => {
    // Step 1 — parse SFN state input. No JobStep write yet because we
    // can't identify a jobId until parsing succeeds.
    const parsed = WorkflowExecutionInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "validate-inputs received malformed workflow input",
          stepName: STEP_NAME,
          zodIssues: parsed.error.issues,
        }),
      );
      throw new IronforgeWorkflowInputError(SANITIZED_INPUT_PARSE_MESSAGE);
    }
    const input = parsed.data;
    const tableName = getTableName();

    // Step 2 — JobStep running. Natural-key upsert; safe on retry.
    await upsertJobStepRunning({
      tableName,
      jobId: input.jobId,
      stepName: STEP_NAME,
    });

    // Step 3 — guard against templateId / manifest divergence. Each
    // Lambda bundles exactly one template's manifest; receiving a
    // workflow execution for a different templateId is a wiring bug
    // (state machine routed wrong). Treat as a workflow-level error,
    // not a user error.
    if (input.templateId !== manifest.id) {
      const errorMessage = SANITIZED_TEMPLATE_MISMATCH_MESSAGE;
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "validate-inputs templateId/manifest mismatch",
          stepName: STEP_NAME,
          jobId: input.jobId,
          inputTemplateId: input.templateId,
          manifestTemplateId: manifest.id,
        }),
      );
      await upsertJobStepFailed({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
        errorName: "IronforgeTemplateMismatchError",
        errorMessage,
        retryable: false,
      });
      throw new IronforgeTemplateMismatchError(errorMessage);
    }

    // Step 4 — apply per-template inputs schema. The first-pass API
    // already ran this at POST /api/services time, but workflow-time
    // re-validation guards against (a) schema drift between the API
    // deploy and the Lambda deploy, and (b) future cases where workflow
    // input arrives via paths other than the API.
    const tidOk = TemplateIdSchema.safeParse(input.templateId);
    if (!tidOk.success) {
      // Templateid passed the WorkflowExecutionInputSchema (which
      // accepts any string) but isn't a known TemplateId. Same root
      // cause as the manifest-mismatch guard above; same handling.
      const errorMessage = SANITIZED_TEMPLATE_MISMATCH_MESSAGE;
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "validate-inputs templateId not in TemplateIdSchema",
          stepName: STEP_NAME,
          jobId: input.jobId,
          inputTemplateId: input.templateId,
        }),
      );
      await upsertJobStepFailed({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
        errorName: "IronforgeTemplateMismatchError",
        errorMessage,
        retryable: false,
      });
      throw new IronforgeTemplateMismatchError(errorMessage);
    }

    const inputsSchema = getInputsSchema(tidOk.data);
    const inputsResult = inputsSchema.safeParse(input.inputs);
    if (!inputsResult.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "validate-inputs per-template inputs schema rejected",
          stepName: STEP_NAME,
          jobId: input.jobId,
          templateId: input.templateId,
          zodIssues: inputsResult.error.issues,
        }),
      );
      await upsertJobStepFailed({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
        errorName: "IronforgeValidationError",
        errorMessage: SANITIZED_VALIDATION_FAILURE_MESSAGE,
        retryable: false,
      });
      throw new IronforgeValidationError(SANITIZED_VALIDATION_FAILURE_MESSAGE);
    }

    // Step 5 — terminal-OK transition. Output flows downstream via SFN
    // ResultPath ($.steps.validate-inputs); no consumer reads these
    // fields today, but they document that validation completed and at
    // what time for forensics.
    const validatedAt = new Date().toISOString();
    const output: ValidateInputsOutput = {
      valid: true,
      templateId: input.templateId,
      validatedAt,
    };
    await upsertJobStepSucceeded({
      tableName,
      jobId: input.jobId,
      stepName: STEP_NAME,
      output,
    });

    return output;
  };
};
