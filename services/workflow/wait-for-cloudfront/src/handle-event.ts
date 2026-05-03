import {
  CloudFrontClient,
  GetDistributionCommand,
} from "@aws-sdk/client-cloudfront";
import {
  type PollResult,
  type StepName,
} from "@ironforge/shared-types";
import {
  getTableName,
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
} from "@ironforge/shared-utils";
import { z } from "zod";

// Real wait-for-cloudfront Lambda body. Replaces the PR-C.2 stub.
//
// SFN-orchestrated polling per ADR-light at docs/state-machine.md
// § "Polling-loop topology". Single-shot Lambda — SFN's Wait state
// schedules the next tick via SecondsPath: $.steps.wait-for-
// cloudfront.nextWaitSeconds. Per-tick state is carried forward in
// PollResult.in_progress.pollState (an opaque bag at the universal
// schema layer; narrowed by WaitForCloudFrontPollStateSchema below).
//
// Per-tick pipeline:
//   1. Parse the SFN-supplied state input as HandlerInputSchema.
//      Schema mismatch is a wiring bug — surface as a custom-named
//      error so SFN's Catch routes to CleanupOnFailure.
//   2. Determine first-tick vs. subsequent-tick from previousPoll
//      discriminator. First tick: init pollState.startedAt = now,
//      pollAttempt = 0, upsert JobStep running. Subsequent ticks:
//      reuse pollState.startedAt (never re-upsert running — natural-
//      key idempotency keeps it correct, but skipping the write also
//      skips the IO).
//   3. Budget check: now - startedAt vs. ELAPSED_BUDGET_MS. Throw
//      IronforgePollTimeoutError if exhausted — Catch routes to
//      CleanupOnFailure with $.error populated automatically.
//   4. cloudfront:GetDistribution call. Any thrown error from the SDK
//      is treated as terminal — wrapped in IronforgeWaitForCloudFront-
//      Error, JobStep marked failed/non-retryable, throw propagates.
//   5. If Status === "Deployed": JobStep succeeded, return PollResult
//      succeeded with { distributionId, deployedAt }.
//   6. Else (InProgress or undefined): return PollResult in_progress
//      with the next scheduled wait + carry-forward pollState.

const STEP_NAME: StepName = "wait-for-cloudfront";

const ELAPSED_BUDGET_MS = 20 * 60 * 1000;

// Schedule of seconds-to-wait BEFORE each subsequent poll tick.
// Index is (justCompletedAttempt - 1). Beyond the schedule's length,
// the tail value applies indefinitely. CloudFront propagation is
// usually 5–10 minutes; the schedule front-loads quick polls and
// settles to the tail rate, with the 20-minute elapsed budget acting
// as the absolute bound. Schedule top-out (90s) is the basis for
// PollResult's nextWaitSeconds.max(120) ceiling — see polling.ts.
const POLL_SCHEDULE_SECONDS: readonly number[] = [30, 30, 60, 60, 60, 90];
const POLL_SCHEDULE_TAIL_SECONDS = 90;

const SANITIZED_INPUT_PARSE_MESSAGE =
  "wait-for-cloudfront input failed schema validation — see CloudWatch for the offending field";
const SANITIZED_TIMEOUT_MESSAGE =
  "CloudFront distribution did not reach Deployed status within the 20-minute polling budget";
const SANITIZED_GET_DISTRIBUTION_MESSAGE =
  "CloudFront GetDistribution call failed — see CloudWatch for the underlying SDK error";

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

export class IronforgePollTimeoutError extends Error {
  override readonly name = "IronforgePollTimeoutError";
}

export class IronforgeWaitForCloudFrontError extends Error {
  override readonly name = "IronforgeWaitForCloudFrontError";
}

// Per-Lambda narrowing of PollResult's opaque pollState bag. Future
// polling Lambdas declare their own equivalent schema; the shared-
// types layer stays template-agnostic.
const WaitForCloudFrontPollStateSchema = z.object({
  startedAt: z.string().datetime(),
  pollAttempt: z.number().int().nonnegative(),
});
type WaitForCloudFrontPollState = z.infer<
  typeof WaitForCloudFrontPollStateSchema
>;

// previousPoll discriminator. "init" arrives on the first tick from
// the InitCloudFrontPolling Pass state; "in_progress" arrives on
// subsequent ticks with the pollState carry-forward intact. Other
// PollResult discriminants (succeeded/failed) MUST NOT reach the
// task — Choice routes them away from the Wait → Task loop, so a
// poll-Lambda invocation seeing them is a wiring bug.
const PreviousPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("init") }),
  z.object({
    status: z.literal("in_progress"),
    nextWaitSeconds: z.number().int().positive(),
    pollState: WaitForCloudFrontPollStateSchema,
  }),
]);

export const HandlerInputSchema = z.object({
  jobId: z.string().uuid(),
  distributionId: z.string().min(1),
  previousPoll: PreviousPollSchema,
});

export type HandlerInput = z.infer<typeof HandlerInputSchema>;

export type WaitForCloudFrontResult = {
  distributionId: string;
  deployedAt: string;
};

// Test-injection seam. Function shape (not the SDK client itself) so
// tests don't depend on aws-sdk-client-mock for this Lambda — the
// surface is one method and a tiny response shape. Mirrors run-
// terraform's SpawnTerraform seam.
export type GetDistributionResponseLike = {
  Distribution?: { Status?: string };
};

export type GetDistributionFn = (params: {
  Id: string;
}) => Promise<GetDistributionResponseLike>;

export type DateNowMs = () => number;

const realCloudFrontClient = new CloudFrontClient({ region: "us-east-1" });

const realGetDistribution: GetDistributionFn = async ({ Id }) => {
  const response = await realCloudFrontClient.send(
    new GetDistributionCommand({ Id }),
  );
  // SDK marks Status optional; preserve that — undefined is treated as
  // still-in-progress by the polling logic.
  const status = response.Distribution?.Status;
  return status === undefined
    ? { Distribution: {} }
    : { Distribution: { Status: status } };
};

const computeNextWaitSeconds = (justCompletedAttempt: number): number => {
  const index = justCompletedAttempt - 1;
  return POLL_SCHEDULE_SECONDS[index] ?? POLL_SCHEDULE_TAIL_SECONDS;
};

export type BuildHandlerDeps = {
  getDistribution?: GetDistributionFn;
  now?: DateNowMs;
};

export const buildHandler = (
  deps: BuildHandlerDeps = {},
): ((
  event: unknown,
) => Promise<PollResult<WaitForCloudFrontResult, WaitForCloudFrontPollState>>) => {
  const getDistribution = deps.getDistribution ?? realGetDistribution;
  const now = deps.now ?? Date.now;

  return async (event) => {
    const parsed = HandlerInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "wait-for-cloudfront received malformed input",
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
      // Natural-key idempotent — re-firing the first tick is harmless.
      // Skipped on subsequent ticks to avoid IO on every poll.
      await upsertJobStepRunning({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
      });
    }

    try {
      // Budget check BEFORE the API call so we don't pay call latency
      // when we're already going to throw.
      const elapsedMs = now() - new Date(startedAt).getTime();
      if (elapsedMs >= ELAPSED_BUDGET_MS) {
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "wait-for-cloudfront elapsed budget exhausted",
            stepName: STEP_NAME,
            jobId: input.jobId,
            distributionId: input.distributionId,
            startedAt,
            elapsedMs,
            completedAttempts,
          }),
        );
        throw new IronforgePollTimeoutError(SANITIZED_TIMEOUT_MESSAGE);
      }

      let response: GetDistributionResponseLike;
      try {
        response = await getDistribution({ Id: input.distributionId });
      } catch (err) {
        const errorName = err instanceof Error ? err.name : "Unknown";
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "CloudFront GetDistribution call failed",
            stepName: STEP_NAME,
            jobId: input.jobId,
            distributionId: input.distributionId,
            errorName,
            errorMessage,
          }),
        );
        throw new IronforgeWaitForCloudFrontError(
          SANITIZED_GET_DISTRIBUTION_MESSAGE,
        );
      }

      const status = response.Distribution?.Status;
      const nextAttempt = completedAttempts + 1;

      if (status === "Deployed") {
        const result: WaitForCloudFrontResult = {
          distributionId: input.distributionId,
          deployedAt: new Date(now()).toISOString(),
        };
        await upsertJobStepSucceeded({
          tableName,
          jobId: input.jobId,
          stepName: STEP_NAME,
          output: result,
        });
        return { status: "succeeded", result };
      }

      // Any non-Deployed status is treated as still-in-progress. AWS
      // documents "InProgress" and "Deployed" as the two states for an
      // active distribution; an undefined/unexpected Status is logged
      // but doesn't fail — the elapsed budget bounds the wait.
      return {
        status: "in_progress",
        nextWaitSeconds: computeNextWaitSeconds(nextAttempt),
        pollState: { startedAt, pollAttempt: nextAttempt },
      };
    } catch (err) {
      const errorName = err instanceof Error ? err.name : "Unknown";
      const errorMessage = err instanceof Error ? err.message : String(err);
      // All thrown errors here are terminal. JobStep failed,
      // retryable=false. SFN's Catch on States.ALL routes the throw
      // to CleanupOnFailure with $.error populated automatically.
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
