// cleanup-on-failure: minimum-viable destroy chain (Phase 1.5).
//
// Replaces the PR-C.2 stub. On workflow failure, attempts three best-effort
// cleanup phases in order, then delegates to the existing cleanupStub for
// DDB status writes (Service/Job/JobStep transitions). Each phase is
// independently failure-tolerant: log + skip on error, never block the
// next phase or the status writes.
//
// Phases:
//   1. terraform destroy (synchronous Lambda invoke of run-terraform with
//      action="destroy"). Bounded to the destroy Lambda's 10-min timeout;
//      CloudFront-distribution destroys may exceed this and fall back to
//      manual cleanup (acknowledged Phase 2+ refactor).
//   2. GitHub repo deletion via App-authenticated Octokit. 404 = success.
//   3. Tfstate file deletion via S3 SDK. NoSuchKey = success.
//
// See docs/tech-debt.md § "Cleanup-on-failure destroy chain (Promoted)"
// for the deliberate scope cuts (concurrent-failure handling, alerting,
// audit logging beyond CloudWatch ERROR lines).

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  buildAuthenticatedOctokit,
  getInstallationToken,
} from "@ironforge/shared-utils";
import { cleanupStub } from "@ironforge/workflow-stub-lib";

const lambdaClient = new LambdaClient({});
const s3Client = new S3Client({});

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`cleanup-on-failure missing required env var: ${name}`);
  }
  return value;
};

type CleanupInput = {
  serviceId?: string;
  jobId?: string;
  serviceName?: string;
};

const log = (level: "INFO" | "WARN" | "ERROR", payload: Record<string, unknown>) => {
  console.log(JSON.stringify({ level, source: "cleanup-on-failure", ...payload }));
};

const runDestroy = async (event: unknown, jobId: string): Promise<void> => {
  try {
    const cmd = new InvokeCommand({
      FunctionName: requireEnv("RUN_TERRAFORM_LAMBDA_NAME"),
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ ...(event as object), action: "destroy" })),
    });
    const result = await lambdaClient.send(cmd);
    if (result.FunctionError) {
      const payloadStr = result.Payload
        ? Buffer.from(result.Payload).toString("utf-8").slice(0, 1000)
        : "";
      log("WARN", {
        message: "terraform destroy invocation returned FunctionError — leaving resources for manual cleanup",
        jobId,
        functionError: result.FunctionError,
        payloadPreview: payloadStr,
      });
      return;
    }
    log("INFO", { message: "terraform destroy completed successfully", jobId });
  } catch (err) {
    log("WARN", {
      message: "terraform destroy threw — leaving resources for manual cleanup",
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

const deleteGitHubRepo = async (serviceName: string, jobId: string): Promise<void> => {
  try {
    const { token } = await getInstallationToken({
      secretArn: requireEnv("GITHUB_APP_SECRET_ARN"),
      appId: requireEnv("GITHUB_APP_ID"),
      installationId: requireEnv("GITHUB_APP_INSTALLATION_ID"),
    });
    const octokit = buildAuthenticatedOctokit({ token });
    await octokit.rest.repos.delete({
      owner: requireEnv("GITHUB_ORG_NAME"),
      repo: serviceName,
    });
    log("INFO", { message: "GitHub repo deleted", repo: serviceName, jobId });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) {
      log("INFO", { message: "GitHub repo already absent (404)", repo: serviceName, jobId });
      return;
    }
    log("WARN", {
      message: "GitHub repo delete failed — leaving for manual cleanup",
      repo: serviceName,
      jobId,
      status,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

const deleteTfstate = async (serviceId: string, jobId: string): Promise<void> => {
  const key = `services/${serviceId}/terraform.tfstate`;
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: requireEnv("TFSTATE_BUCKET"),
        Key: key,
      }),
    );
    log("INFO", { message: "tfstate file deleted", key, jobId });
  } catch (err) {
    const code = (err as { name?: string })?.name;
    if (code === "NoSuchKey") {
      log("INFO", { message: "tfstate file already absent", key, jobId });
      return;
    }
    log("WARN", {
      message: "tfstate delete failed — leaving for manual cleanup",
      key,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const handler = async (event: unknown): Promise<unknown> => {
  const input = (event ?? {}) as CleanupInput;
  const { serviceId, jobId, serviceName } = input;

  if (!serviceId || !jobId || !serviceName) {
    // Malformed input — destroy chain can't run without identifiers.
    // cleanupStub validates the schema and surfaces the right error;
    // delegate without attempting destroy.
    log("WARN", {
      message: "missing serviceId/jobId/serviceName — skipping destroy chain, delegating to cleanupStub for status writes",
      serviceId,
      jobId,
      serviceName,
    });
    return cleanupStub(event);
  }

  // Phase 1 — terraform destroy. Bounded best-effort.
  await runDestroy(event, jobId);

  // Phase 2 — GitHub repo. Bounded best-effort. Runs after destroy because
  // the deploy IAM role's terraform-managed lifecycle should be cleaned up
  // before its referenced repo is removed (avoids a transient state where
  // the role exists but the repo it grants OIDC access for doesn't).
  await deleteGitHubRepo(serviceName, jobId);

  // Phase 3 — tfstate file. Last because terraform destroy reads the state
  // to know what to destroy; deleting it earlier would force destroy into
  // a no-op refresh path against an empty state.
  await deleteTfstate(serviceId, jobId);

  // Phase 4 — DDB status writes. Always runs regardless of upstream phase
  // outcomes. cleanupStub is the existing PR-C.2 implementation.
  return cleanupStub(event);
};
