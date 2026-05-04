// cleanup-on-failure: best-effort destroy chain + DDB status writes.
//
// On workflow failure, runs the destroy chain (terraform destroy →
// GitHub repo → tfstate) via the shared @ironforge/destroy-chain
// package, then delegates to cleanupStub for the DDB transitions
// (Service: provisioning → failed, Job: running → failed, JobStep
// upserts).
//
// Each phase is independently failure-tolerant: log + continue on
// error, never block the next phase or the status writes. Failures
// log WARN with "leaving resources for manual cleanup" because we
// won't auto-retry — operators can re-run from the SFN console or
// clean up manually using the runbook.
//
// See docs/tech-debt.md § "Cleanup-on-failure destroy chain (Promoted)"
// for the deliberate scope cuts (concurrent-failure handling, alerting,
// audit logging beyond CloudWatch ERROR lines).

import {
  buildTfstateKey,
  destroyTerraform,
  deleteGithubRepo,
  deleteTfstate,
} from "@ironforge/destroy-chain";
import { cleanupStub } from "@ironforge/workflow-stub-lib";

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

const phaseTerraform = async (event: unknown, jobId: string): Promise<void> => {
  const outcome = await destroyTerraform({
    runTerraformLambdaName: requireEnv("RUN_TERRAFORM_LAMBDA_NAME"),
    event,
  });
  if (outcome.status === "succeeded") {
    log("INFO", { message: "terraform destroy completed successfully", jobId });
    return;
  }
  if (outcome.status === "skipped") {
    log("INFO", { message: "terraform destroy skipped", jobId, reason: outcome.reason });
    return;
  }
  if (outcome.failureKind === "function-error") {
    log("WARN", {
      message: "terraform destroy invocation returned FunctionError — leaving resources for manual cleanup",
      jobId,
      functionError: outcome.functionError,
      payloadPreview: outcome.payloadPreview,
    });
    return;
  }
  log("WARN", {
    message: "terraform destroy threw — leaving resources for manual cleanup",
    jobId,
    error: outcome.error,
  });
};

const phaseGithubRepo = async (serviceName: string, jobId: string): Promise<void> => {
  const outcome = await deleteGithubRepo({
    owner: requireEnv("GITHUB_ORG_NAME"),
    repo: serviceName,
    appAuth: {
      secretArn: requireEnv("GITHUB_APP_SECRET_ARN"),
      appId: requireEnv("GITHUB_APP_ID"),
      installationId: requireEnv("GITHUB_APP_INSTALLATION_ID"),
    },
  });
  if (outcome.status === "succeeded") {
    if (outcome.detail === "already-absent") {
      log("INFO", { message: "GitHub repo already absent (404)", repo: serviceName, jobId });
    } else {
      log("INFO", { message: "GitHub repo deleted", repo: serviceName, jobId });
    }
    return;
  }
  if (outcome.status === "skipped") {
    log("INFO", { message: "GitHub repo delete skipped", repo: serviceName, jobId, reason: outcome.reason });
    return;
  }
  log("WARN", {
    message: "GitHub repo delete failed — leaving for manual cleanup",
    repo: serviceName,
    jobId,
    status: outcome.httpStatus,
    error: outcome.error,
  });
};

const phaseTfstate = async (serviceId: string, jobId: string): Promise<void> => {
  const key = buildTfstateKey(serviceId);
  const outcome = await deleteTfstate({
    tfstateBucket: requireEnv("TFSTATE_BUCKET"),
    serviceId,
  });
  if (outcome.status === "succeeded") {
    if (outcome.detail === "already-absent") {
      log("INFO", { message: "tfstate file already absent", key, jobId });
    } else {
      log("INFO", { message: "tfstate file deleted", key, jobId });
    }
    return;
  }
  if (outcome.status === "skipped") {
    log("INFO", { message: "tfstate delete skipped", key, jobId, reason: outcome.reason });
    return;
  }
  log("WARN", {
    message: "tfstate delete failed — leaving for manual cleanup",
    key,
    jobId,
    error: outcome.error,
  });
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

  // Phase ordering matters — see runDestroyChain comment for the full
  // rationale. Briefly: terraform destroy reads tfstate (so tfstate
  // must outlive it), GitHub repo deletion drops the OIDC-trust target
  // (so terraform-managed deploy role must be torn down first).

  await phaseTerraform(event, jobId);
  await phaseGithubRepo(serviceName, jobId);
  await phaseTfstate(serviceId, jobId);

  // Phase 4 — DDB status writes. Always runs regardless of upstream
  // phase outcomes. cleanupStub writes Service: provisioning → failed
  // (failedWorkflow="provisioning") and Job: running → failed.
  return cleanupStub(event);
};
