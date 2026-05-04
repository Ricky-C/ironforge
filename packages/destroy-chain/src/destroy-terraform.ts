import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

import type { DestroyTerraformOutcome } from "./types.js";

// Module-scoped Lambda client. aws-sdk-client-mock intercepts at SDK
// middleware regardless of which client instance the caller holds, so
// tests don't need DI. Mirrors the pattern in shared-utils/aws/clients.
const lambdaClient = new LambdaClient({});

type DestroyTerraformInput = {
  // Function name (or full ARN — Lambda accepts either) of the
  // run-terraform Lambda. Caller resolves from env / Lambda config; the
  // package stays unaware of how that resolution happens.
  runTerraformLambdaName: string;
  // The SFN execution event. The package serializes and forwards as-is
  // with `action: "destroy"` merged on, matching the run-terraform
  // Lambda's input contract for the destroy code path.
  event: unknown;
};

// Synchronously invokes the run-terraform Lambda with action=destroy.
// Returns succeeded when the Lambda returned without FunctionError,
// failed (function-error) when FunctionError was set on the response,
// failed (exception) when the invoke itself threw.
//
// The Lambda's 10-min timeout bounds this call; CloudFront-distribution
// destroys may exceed it (acknowledged Phase 2+ refactor — async destroy
// via SFN polling, see Phase 1.5 candidate list).
export const destroyTerraform = async (
  input: DestroyTerraformInput,
): Promise<DestroyTerraformOutcome> => {
  const start = Date.now();
  try {
    const cmd = new InvokeCommand({
      FunctionName: input.runTerraformLambdaName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(
        JSON.stringify({ ...(input.event as object), action: "destroy" }),
      ),
    });
    const result = await lambdaClient.send(cmd);
    if (result.FunctionError) {
      const payloadPreview = result.Payload
        ? Buffer.from(result.Payload).toString("utf-8").slice(0, 1000)
        : "";
      return {
        status: "failed",
        durationMs: Date.now() - start,
        failureKind: "function-error",
        functionError: result.FunctionError,
        payloadPreview,
      };
    }
    return { status: "succeeded", durationMs: Date.now() - start };
  } catch (err) {
    return {
      status: "failed",
      durationMs: Date.now() - start,
      failureKind: "exception",
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
