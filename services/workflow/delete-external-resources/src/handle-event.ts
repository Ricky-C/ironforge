import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  deleteGithubRepo,
  deleteTfstate,
  type DeleteGithubRepoOutcome,
  type DeleteTfstateOutcome,
} from "@ironforge/destroy-chain";
import {
  buildJobPK,
  buildServicePK,
  JOB_SK_META,
  SERVICE_SK_META,
  ServiceNameSchema,
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

// delete-external-resources: deprovision SFN State 2 happy path.
//
// State 1 (DeprovisionTerraform, run-terraform with action=destroy) ran
// before us. Our job: delete the GitHub repo + tfstate file (via
// @ironforge/destroy-chain), then transition the entity rows:
//
//   Service: deprovisioning → archived (currentJobId cleared, archivedAt set)
//   Job:     running        → succeeded (completedAt set)
//   JobStep: deprovision-external-resources running → succeeded
//
// Throws on ANY destroy-chain sub-op failure so SFN's Catch routes to
// DeprovisionFailed (which marks Service deprovisioning → failed with
// failedWorkflow="deprovisioning"). Re-issue DELETE retries the chain.
// All sub-ops are idempotent (404 / NoSuchKey treated as success), so
// retry is safe.
//
// Same idempotent-retry pattern as finalize: if the Service / Job
// conditional-update fails, GetItem inspects actual state. Already-
// terminal-with-our-markers → success (Lambda timeout post-DDB-write).
// Anything else → throw IronforgeDeprovisionError with structured
// operator-triage context.

const STEP_NAME: StepName = "deprovision-external-resources";

const SANITIZED_INPUT_PARSE_MESSAGE =
  "delete-external-resources received malformed input — see CloudWatch for the offending field";

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

class IronforgeDeprovisionExternalResourcesError extends Error {
  override readonly name = "IronforgeDeprovisionExternalResourcesError";

  constructor(
    message: string,
    public readonly context: Record<string, unknown>,
  ) {
    super(message);
  }
}

export {
  IronforgeWorkflowInputError,
  IronforgeDeprovisionExternalResourcesError,
};

// Focused input — only the fields this Lambda needs. The SFN event
// shape is the full WorkflowExecutionInput, but we narrow at the
// Lambda boundary to keep the contract explicit.
export const HandlerInputSchema = z.object({
  jobId: z.string().uuid(),
  serviceId: z.string().uuid(),
  serviceName: ServiceNameSchema,
});

export type HandlerInput = z.infer<typeof HandlerInputSchema>;

export type DeleteExternalResourcesOutput = {
  archivedAt: string;
  github: { detail: "deleted" | "already-absent" };
  tfstate: { detail: "deleted" | "already-absent" };
};

export type DateNowMs = () => number;

// Env-bound config resolved per-invoke (not at module load) so test
// environments can override without re-importing.
type Env = {
  githubOrg: string;
  githubAppSecretArn: string;
  githubAppId: string;
  githubAppInstallationId: string;
  tfstateBucket: string;
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `delete-external-resources missing required env var: ${name}`,
    );
  }
  return value;
};

const readEnv = (): Env => ({
  githubOrg: requireEnv("GITHUB_ORG_NAME"),
  githubAppSecretArn: requireEnv("GITHUB_APP_SECRET_ARN"),
  githubAppId: requireEnv("GITHUB_APP_ID"),
  githubAppInstallationId: requireEnv("GITHUB_APP_INSTALLATION_ID"),
  tfstateBucket: requireEnv("TFSTATE_BUCKET"),
});

// Dependency seams — tests inject in-memory fakes for the destroy-chain
// primitives instead of mocking @aws-sdk/* clients all the way down.
export type DestroyChainDeps = {
  deleteGithubRepo: typeof deleteGithubRepo;
  deleteTfstate: typeof deleteTfstate;
};

export type BuildHandlerDeps = {
  now?: DateNowMs;
  destroyChain?: DestroyChainDeps;
  readEnv?: () => Env;
};

type ServiceInspect = {
  status: string | null;
  currentJobId: string | null;
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

const summarizeFailedOutcome = (
  outcome: DeleteGithubRepoOutcome | DeleteTfstateOutcome,
): Record<string, unknown> => {
  if (outcome.status !== "failed") return { status: outcome.status };
  // Each failed outcome shape carries different fields — flatten the
  // discriminator-specific bag for the error context. Operators read
  // these in CloudWatch when triaging.
  const base: Record<string, unknown> = {
    status: outcome.status,
    durationMs: outcome.durationMs,
    error: outcome.error,
  };
  if ("httpStatus" in outcome) base["httpStatus"] = outcome.httpStatus;
  return base;
};

export const buildHandler = (
  deps: BuildHandlerDeps = {},
): ((event: unknown) => Promise<DeleteExternalResourcesOutput>) => {
  const now = deps.now ?? Date.now;
  const chain: DestroyChainDeps = deps.destroyChain ?? {
    deleteGithubRepo,
    deleteTfstate,
  };
  const env = deps.readEnv ?? readEnv;

  return async (event: unknown): Promise<DeleteExternalResourcesOutput> => {
    // Step 1 — parse focused input.
    const parsed = HandlerInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "delete-external-resources received malformed input",
          stepName: STEP_NAME,
          zodIssues: parsed.error.issues,
        }),
      );
      throw new IronforgeWorkflowInputError(SANITIZED_INPUT_PARSE_MESSAGE);
    }
    const input = parsed.data;
    const tableName = getTableName();
    const archivedAt = new Date(now()).toISOString();
    const cfg = env();

    // Step 2 — JobStep running.
    await upsertJobStepRunning({
      tableName,
      jobId: input.jobId,
      stepName: STEP_NAME,
    });

    try {
      // Step 3 — destroy chain. Both sub-ops are idempotent (404 / NoSuchKey
      // treated as success). Failure → throw → SFN catch → DeprovisionFailed.
      // Sequential rather than parallel: keeps log ordering deterministic
      // and total time difference is negligible (both are sub-second).
      const githubOutcome = await chain.deleteGithubRepo({
        owner: cfg.githubOrg,
        repo: input.serviceName,
        appAuth: {
          secretArn: cfg.githubAppSecretArn,
          appId: cfg.githubAppId,
          installationId: cfg.githubAppInstallationId,
        },
      });
      if (githubOutcome.status !== "succeeded") {
        // failed → operator-visible error; skipped → unexpected
        // (current primitives never emit skipped; reserved future path).
        throw new IronforgeDeprovisionExternalResourcesError(
          githubOutcome.status === "failed"
            ? "GitHub repo delete failed during deprovisioning"
            : "GitHub repo delete returned unexpected skipped outcome",
          {
            phase: "deleteGithubRepo",
            jobId: input.jobId,
            serviceId: input.serviceId,
            repo: input.serviceName,
            outcome:
              githubOutcome.status === "failed"
                ? summarizeFailedOutcome(githubOutcome)
                : { status: githubOutcome.status, reason: githubOutcome.reason },
          },
        );
      }

      const tfstateOutcome = await chain.deleteTfstate({
        tfstateBucket: cfg.tfstateBucket,
        serviceId: input.serviceId,
      });
      if (tfstateOutcome.status !== "succeeded") {
        throw new IronforgeDeprovisionExternalResourcesError(
          tfstateOutcome.status === "failed"
            ? "tfstate file delete failed during deprovisioning"
            : "tfstate file delete returned unexpected skipped outcome",
          {
            phase: "deleteTfstate",
            jobId: input.jobId,
            serviceId: input.serviceId,
            outcome:
              tfstateOutcome.status === "failed"
                ? summarizeFailedOutcome(tfstateOutcome)
                : { status: tfstateOutcome.status, reason: tfstateOutcome.reason },
          },
        );
      }

      // Step 4 — Service: deprovisioning → archived. Conditional on
      // status; companion fields (archivedAt, currentJobId=null,
      // updatedAt) applied atomically.
      const serviceTransition = await transitionStatus({
        tableName,
        key: {
          PK: buildServicePK(input.serviceId),
          SK: SERVICE_SK_META,
        },
        fromStatus: "deprovisioning",
        toStatus: "archived",
        additionalUpdates: {
          currentJobId: null,
          archivedAt,
          updatedAt: archivedAt,
        },
      });

      if (!serviceTransition.transitioned) {
        // Idempotent retry: if Service is already archived (Lambda
        // timeout post-DDB-write, then SFN retry), continue to Job
        // transition. Other states are unexpected and throw.
        const actual = await inspectService(tableName, input.serviceId);
        if (actual.status === "archived" && actual.currentJobId === null) {
          console.info(
            JSON.stringify({
              level: "INFO",
              message:
                "delete-external-resources Service transition was a no-op (already archived)",
              stepName: STEP_NAME,
              jobId: input.jobId,
              serviceId: input.serviceId,
            }),
          );
        } else {
          throw new IronforgeDeprovisionExternalResourcesError(
            `Service ${input.serviceId} in unexpected state during archive`,
            {
              phase: "transitionService",
              serviceId: input.serviceId,
              jobId: input.jobId,
              expectedStatus: "archived",
              actualStatus: actual.status,
              actualCurrentJobId: actual.currentJobId,
            },
          );
        }
      }

      // Step 5 — Job: running → succeeded.
      const jobTransition = await transitionStatus({
        tableName,
        key: { PK: buildJobPK(input.jobId), SK: JOB_SK_META },
        fromStatus: "running",
        toStatus: "succeeded",
        additionalUpdates: {
          completedAt: archivedAt,
          updatedAt: archivedAt,
        },
      });

      if (!jobTransition.transitioned) {
        const actual = await inspectJob(tableName, input.jobId);
        if (actual.status === "succeeded") {
          console.info(
            JSON.stringify({
              level: "INFO",
              message:
                "delete-external-resources Job transition was a no-op (already succeeded)",
              stepName: STEP_NAME,
              jobId: input.jobId,
            }),
          );
        } else {
          throw new IronforgeDeprovisionExternalResourcesError(
            `Job ${input.jobId} in unexpected state during succeed transition`,
            {
              phase: "transitionJob",
              serviceId: input.serviceId,
              jobId: input.jobId,
              expectedStatus: "succeeded",
              actualStatus: actual.status,
            },
          );
        }
      }

      // Step 6 — JobStep succeeded. Output mirrors the destroy-chain
      // outcomes so operators can confirm "deleted" vs "already-absent"
      // without log spelunking.
      const output: DeleteExternalResourcesOutput = {
        archivedAt,
        github: { detail: githubOutcome.detail },
        tfstate: { detail: tfstateOutcome.detail },
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
