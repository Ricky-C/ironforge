import {
  type PollResult,
  type StepName,
} from "@ironforge/shared-types";
import {
  buildAuthenticatedOctokit,
  getInstallationToken,
  getTableName,
  IronforgeGitHubAuthError,
  IronforgeGitHubProvisionError,
  IronforgeGitHubRateLimitedError,
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
  type AuthenticatedOctokit,
  type InstallationToken,
} from "@ironforge/shared-utils";
import { z } from "zod";

// Real wait-for-deploy Lambda body. Newly introduced at PR-C.8 (no
// stub predecessor — this task is added to enforce status-semantic
// integrity per docs/conventions.md § "Service status reflects
// functional state, not workflow stage").
//
// SFN-orchestrated polling per docs/conventions.md § "SFN-orchestrated
// polling pattern" — same shape as wait-for-cloudfront. Single-shot
// per invocation; SFN's Wait state schedules the next tick via
// SecondsPath: $.steps.wait-for-deploy.nextWaitSeconds. Per-tick
// state carries forward in PollResult.in_progress.pollState (an
// opaque bag at the universal layer; narrowed by
// WaitForDeployPollStateSchema below).
//
// Per-tick pipeline:
//   1. Parse SFN-supplied state input as HandlerInputSchema.
//   2. Determine first-tick vs. subsequent from previousPoll
//      discriminator. First tick captures startedAt = now() and
//      upserts JobStep running.
//   3. Budget check (10-min wall-clock). Throw IronforgePollTimeout-
//      Error if exhausted — Catch routes to CleanupOnFailure.
//   4. Mint a fresh installation token (per ADR-008: per-invocation,
//      no cache) and call listWorkflowRuns on the user's repo.
//   5. Filter runs by name match: "Deploy [<correlationId>]". If no
//      match found, return in_progress (workflow_dispatch is async;
//      first poll might fire before GitHub queues the run).
//   6. Inspect status + conclusion:
//      - status !== "completed" → in_progress
//      - status === "completed" + conclusion === "success" →
//        JobStep succeeded, return PollResult succeeded
//      - status === "completed" + conclusion in non-success set →
//        throw IronforgeDeployRunError, JobStep failed/non-retryable
//
// Status-integrity contract: this Lambda's terminal-success is the
// only path that lets Finalize transition Service.status to "live".
// If we return succeeded prematurely, Service.status becomes a lie.

const STEP_NAME: StepName = "wait-for-deploy";

const ELAPSED_BUDGET_MS = 10 * 60 * 1000;

// Schedule reused from wait-for-cloudfront (PR-C.7) — per design
// conversation locked at PR-C.8: per-consumer schedule tuning is
// premature; reuse is operational simplicity. Tune empirically only
// if dashboards show frequent 5+ polls.
const POLL_SCHEDULE_SECONDS: readonly number[] = [30, 30, 60, 60, 60, 90];
const POLL_SCHEDULE_TAIL_SECONDS = 90;

// GitHub Actions API enums (subset relevant to our state classification).
// Source: https://docs.github.com/en/rest/actions/workflow-runs
const NON_TERMINAL_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
  "action_required",
]);

const TERMINAL_FAIL_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "skipped",
  "stale",
  "startup_failure",
  "neutral",
]);

const SANITIZED_INPUT_PARSE_MESSAGE =
  "wait-for-deploy input failed schema validation — see CloudWatch for the offending field";
const SANITIZED_TIMEOUT_MESSAGE =
  "Deploy run did not reach completed status within the 10-minute polling budget";
const SANITIZED_DEPLOY_FAILED_MESSAGE =
  "Deploy run completed with a non-success conclusion — see CloudWatch + the run's GitHub URL";
const SANITIZED_PROVISION_MESSAGE =
  "GitHub deploy-run lookup failed — see CloudWatch for endpoint + status";

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

// Same name as wait-for-cloudfront's class. SFN matches errors by
// the string name, so a separate class definition is fine — both
// instances trigger the same Catch routing.
export class IronforgePollTimeoutError extends Error {
  override readonly name = "IronforgePollTimeoutError";
}

export class IronforgeDeployRunError extends Error {
  override readonly name = "IronforgeDeployRunError";
}

// Static config from env vars. Lazy-on-first-call per
// docs/conventions.md § "Cold-start configuration loading".
type LambdaConfig = {
  secretArn: string;
  appId: string;
  installationId: string;
};

let configCache: LambdaConfig | undefined;
const getConfig = (): LambdaConfig => {
  if (configCache !== undefined) return configCache;
  const secretArn = process.env["GITHUB_APP_SECRET_ARN"];
  const appId = process.env["GITHUB_APP_ID"];
  const installationId = process.env["GITHUB_APP_INSTALLATION_ID"];
  const missing: string[] = [];
  if (!secretArn) missing.push("GITHUB_APP_SECRET_ARN");
  if (!appId) missing.push("GITHUB_APP_ID");
  if (!installationId) missing.push("GITHUB_APP_INSTALLATION_ID");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for wait-for-deploy Lambda: ${missing.join(", ")}`,
    );
  }
  configCache = {
    secretArn: secretArn!,
    appId: appId!,
    installationId: installationId!,
  };
  return configCache;
};

export const __resetConfigCacheForTests = (): void => {
  configCache = undefined;
};

const WaitForDeployPollStateSchema = z.object({
  startedAt: z.string().datetime(),
  pollAttempt: z.number().int().nonnegative(),
});
type WaitForDeployPollState = z.infer<typeof WaitForDeployPollStateSchema>;

const PreviousPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("init") }),
  z.object({
    status: z.literal("in_progress"),
    nextWaitSeconds: z.number().int().positive(),
    pollState: WaitForDeployPollStateSchema,
  }),
]);

export const HandlerInputSchema = z.object({
  jobId: z.string().uuid(),
  correlationId: z.string().min(1),
  repoFullName: z.string().min(1).regex(/^[^/]+\/[^/]+$/),
  previousPoll: PreviousPollSchema,
});

export type HandlerInput = z.infer<typeof HandlerInputSchema>;

export type WaitForDeployResult = {
  runId: number;
  runUrl: string;
  conclusion: "success";
  completedAt: string;
};

const splitRepoFullName = (
  repoFullName: string,
): { owner: string; repo: string } => {
  const slash = repoFullName.indexOf("/");
  return {
    owner: repoFullName.substring(0, slash),
    repo: repoFullName.substring(slash + 1),
  };
};

const computeNextWaitSeconds = (justCompletedAttempt: number): number => {
  const index = justCompletedAttempt - 1;
  return POLL_SCHEDULE_SECONDS[index] ?? POLL_SCHEDULE_TAIL_SECONDS;
};

const expectedRunName = (correlationId: string): string =>
  `Deploy [${correlationId}]`;

// Narrowed Octokit response shape. listWorkflowRuns returns more
// fields than we touch; staying explicit about which ones we depend
// on means a future GitHub API breaking-change surfaces here as a
// type error, not as a silent runtime divergence.
type WorkflowRunSummary = {
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  updated_at: string;
};

export type ListWorkflowRunsFn = (params: {
  owner: string;
  repo: string;
  correlationId: string;
}) => Promise<WorkflowRunSummary | null>;

const realListWorkflowRuns = (
  octokit: AuthenticatedOctokit,
): ListWorkflowRunsFn => async ({ owner, repo, correlationId }) => {
  const expected = expectedRunName(correlationId);
  // per_page=20 — enough headroom for ordinary user activity (manual
  // deploy.yml dispatches, push triggers) without paginating.
  const response = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: "deploy.yml",
    per_page: 20,
  });
  const runs = response.data.workflow_runs;
  // Find newest matching run. listWorkflowRuns returns newest first
  // by default; the first match is the right one. UUID-derived run-
  // name makes collisions impossible barring an operator manually
  // dispatching with our jobId, which is out-of-scope.
  for (const run of runs) {
    if (run.name === expected) {
      return {
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        html_url: run.html_url,
        updated_at: run.updated_at,
      };
    }
  }
  return null;
};

export type DateNowMs = () => number;

export type BuildHandlerDeps = {
  config?: LambdaConfig;
  getInstallationToken?: typeof getInstallationToken;
  buildOctokit?: (token: string) => AuthenticatedOctokit;
  // Test injection seam — production wires through realListWorkflowRuns
  // backed by a real Octokit. Tests stub directly without booting an
  // Octokit instance.
  listWorkflowRuns?: ListWorkflowRunsFn;
  now?: DateNowMs;
};

export const buildHandler = (
  deps: BuildHandlerDeps = {},
): ((
  event: unknown,
) => Promise<PollResult<WaitForDeployResult, WaitForDeployPollState>>) => {
  const mintToken = deps.getInstallationToken ?? getInstallationToken;
  const buildOctokit =
    deps.buildOctokit ??
    ((token: string): AuthenticatedOctokit =>
      buildAuthenticatedOctokit({ token }));
  const now = deps.now ?? Date.now;

  return async (event) => {
    const parsed = HandlerInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "wait-for-deploy received malformed input",
          stepName: STEP_NAME,
          zodIssues: parsed.error.issues,
        }),
      );
      throw new IronforgeWorkflowInputError(SANITIZED_INPUT_PARSE_MESSAGE);
    }
    const input = parsed.data;
    const tableName = getTableName();

    const { startedAt, completedAttempts, isFirstTick } =
      input.previousPoll.status === "init"
        ? {
            startedAt: new Date(now()).toISOString(),
            completedAttempts: 0,
            isFirstTick: true as const,
          }
        : {
            startedAt: input.previousPoll.pollState.startedAt,
            completedAttempts: input.previousPoll.pollState.pollAttempt,
            isFirstTick: false as const,
          };

    if (isFirstTick) {
      await upsertJobStepRunning({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
      });
    }

    try {
      const elapsedMs = now() - new Date(startedAt).getTime();
      if (elapsedMs >= ELAPSED_BUDGET_MS) {
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "wait-for-deploy elapsed budget exhausted",
            stepName: STEP_NAME,
            jobId: input.jobId,
            correlationId: input.correlationId,
            startedAt,
            elapsedMs,
            completedAttempts,
          }),
        );
        throw new IronforgePollTimeoutError(SANITIZED_TIMEOUT_MESSAGE);
      }

      const config = deps.config ?? getConfig();

      // Per ADR-008: fresh installation token per invocation. Polling
      // tick frequency (30-90s) means token reuse would marginally
      // reduce mint cost but the no-cache contract is the security-
      // posture decision; we don't break it for performance gains.
      const minted: InstallationToken = await mintToken({
        secretArn: config.secretArn,
        appId: config.appId,
        installationId: config.installationId,
      });
      const octokit = buildOctokit(minted.token);
      const listRuns = deps.listWorkflowRuns ?? realListWorkflowRuns(octokit);

      const { owner, repo } = splitRepoFullName(input.repoFullName);

      let run: WorkflowRunSummary | null;
      try {
        run = await listRuns({
          owner,
          repo,
          correlationId: input.correlationId,
        });
      } catch (err) {
        throw classifyGitHubError(
          err,
          `GET /repos/${owner}/${repo}/actions/workflows/deploy.yml/runs`,
          config.appId,
          config.installationId,
        );
      }

      const nextAttempt = completedAttempts + 1;

      // Run not yet visible — workflow_dispatch is async; GitHub may
      // need 1-3 seconds to queue. First poll fires 30s after
      // dispatch (per the schedule), so this case is rare but real.
      if (run === null) {
        return {
          status: "in_progress",
          nextWaitSeconds: computeNextWaitSeconds(nextAttempt),
          pollState: { startedAt, pollAttempt: nextAttempt },
        };
      }

      const status = run.status;
      const conclusion = run.conclusion;

      if (status !== "completed") {
        // Includes "queued", "in_progress", and any other non-completed
        // GitHub-side status. The set is enumerated above for
        // documentation — we don't fail closed if GitHub introduces a
        // new status we haven't seen, on the principle that a forward-
        // compatible default is safer than a workflow failure.
        if (!NON_TERMINAL_STATUSES.has(status ?? "")) {
          console.warn(
            JSON.stringify({
              level: "WARN",
              message:
                "wait-for-deploy saw an unrecognized non-completed status — treating as in_progress",
              stepName: STEP_NAME,
              jobId: input.jobId,
              runId: run.id,
              status,
            }),
          );
        }
        return {
          status: "in_progress",
          nextWaitSeconds: computeNextWaitSeconds(nextAttempt),
          pollState: { startedAt, pollAttempt: nextAttempt },
        };
      }

      // status === "completed" — terminal one way or another.
      if (conclusion === "success") {
        const result: WaitForDeployResult = {
          runId: run.id,
          runUrl: run.html_url,
          conclusion: "success",
          completedAt: run.updated_at,
        };
        await upsertJobStepSucceeded({
          tableName,
          jobId: input.jobId,
          stepName: STEP_NAME,
          output: result,
        });
        return { status: "succeeded", result };
      }

      // Terminal-failed conclusion. Throw IronforgeDeployRunError;
      // SFN's Catch on States.ALL routes to CleanupOnFailure with
      // $.error populated automatically.
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "wait-for-deploy run completed with non-success conclusion",
          stepName: STEP_NAME,
          jobId: input.jobId,
          runId: run.id,
          runUrl: run.html_url,
          conclusion,
          isKnownFailureConclusion: TERMINAL_FAIL_CONCLUSIONS.has(
            conclusion ?? "",
          ),
        }),
      );
      throw new IronforgeDeployRunError(SANITIZED_DEPLOY_FAILED_MESSAGE);
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

// Same classifier shape as trigger-deploy. Auth + rate-limit map to
// the existing taxonomy classes; everything else falls into a generic
// IronforgeGitHubProvisionError. Caller can upgrade as needed.
const classifyGitHubError = (
  err: unknown,
  endpoint: string,
  appId: string,
  installationId: string,
): Error => {
  const status =
    err !== null &&
    typeof err === "object" &&
    "status" in err &&
    typeof err.status === "number"
      ? err.status
      : undefined;
  const headers =
    err !== null &&
    typeof err === "object" &&
    "response" in err &&
    err.response !== null &&
    typeof err.response === "object" &&
    "headers" in err.response &&
    err.response.headers !== null &&
    typeof err.response.headers === "object"
      ? (err.response.headers as Record<string, string>)
      : undefined;
  const rateLimitRemaining = headers?.["x-ratelimit-remaining"];
  const rateLimitReset = headers?.["x-ratelimit-reset"];

  if (status === 403 && rateLimitRemaining === "0") {
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "GitHub rate limit hit",
        endpoint,
        appId,
        installationId,
        rateLimitReset,
      }),
    );
    return new IronforgeGitHubRateLimitedError(
      "GitHub rate-limit hit — see CloudWatch for X-RateLimit-Reset value",
      { endpoint, appId, installationId, status: 403 },
    );
  }
  if (status === 401 || status === 403) {
    return new IronforgeGitHubAuthError(
      "GitHub API rejected the installation token",
      { mintType: "token-exchange", appId, installationId, endpoint, status },
    );
  }
  return new IronforgeGitHubProvisionError(SANITIZED_PROVISION_MESSAGE, {
    operation: "unknown",
    endpoint,
    appId,
    installationId,
    ...(typeof status === "number" ? { status } : {}),
  });
};
