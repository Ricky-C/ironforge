import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  buildHandler,
  HandlerInputSchema,
  IronforgePollTimeoutError,
  IronforgeWaitForCloudFrontError,
  type GetDistributionFn,
  type GetDistributionResponseLike,
} from "./handle-event.js";

const ddbMock = mockClient(docClient);

const ORIGINAL_TABLE = process.env["DYNAMODB_TABLE_NAME"];
beforeAll(() => {
  process.env["DYNAMODB_TABLE_NAME"] = "ironforge-test";
});
afterAll(() => {
  if (ORIGINAL_TABLE === undefined) {
    delete process.env["DYNAMODB_TABLE_NAME"];
  } else {
    process.env["DYNAMODB_TABLE_NAME"] = ORIGINAL_TABLE;
  }
});

beforeEach(() => {
  ddbMock.reset();
});

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const DISTRIBUTION_ID = "E1ABC123XYZ";
const STARTED_AT = "2026-05-03T12:00:00.000Z";
const STARTED_AT_MS = new Date(STARTED_AT).getTime();

const FIRST_TICK_INPUT = {
  jobId: JOB_ID,
  distributionId: DISTRIBUTION_ID,
  previousPoll: { status: "init" as const },
};

const subsequentTickInput = (
  pollAttempt: number,
  startedAt = STARTED_AT,
): unknown => ({
  jobId: JOB_ID,
  distributionId: DISTRIBUTION_ID,
  previousPoll: {
    status: "in_progress" as const,
    nextWaitSeconds: 30,
    pollState: { startedAt, pollAttempt },
  },
});

// Records each GetDistribution call. Tests stage a sequence of responses
// (one per call) or pass a single response repeated. Function-shaped seam
// avoids aws-sdk-client-mock for this Lambda — surface is one call.
type StubGetDistributionState = {
  calls: Array<{ Id: string }>;
};

const stubGetDistribution = (
  response: GetDistributionResponseLike | Error,
): {
  getDistribution: GetDistributionFn;
  state: StubGetDistributionState;
} => {
  const state: StubGetDistributionState = { calls: [] };
  const getDistribution: GetDistributionFn = async (params) => {
    state.calls.push(params);
    if (response instanceof Error) throw response;
    return response;
  };
  return { getDistribution, state };
};

const stubNow = (ms: number): { now: () => number; advance: (ms: number) => void } => {
  let current = ms;
  return {
    now: () => current,
    advance: (delta) => {
      current += delta;
    },
  };
};

describe("HandlerInputSchema", () => {
  it("accepts init previousPoll", () => {
    expect(HandlerInputSchema.safeParse(FIRST_TICK_INPUT).success).toBe(true);
  });

  it("accepts in_progress previousPoll with pollState", () => {
    expect(
      HandlerInputSchema.safeParse(subsequentTickInput(3)).success,
    ).toBe(true);
  });

  it("rejects in_progress previousPoll without pollState", () => {
    expect(
      HandlerInputSchema.safeParse({
        jobId: JOB_ID,
        distributionId: DISTRIBUTION_ID,
        previousPoll: { status: "in_progress", nextWaitSeconds: 30 },
      }).success,
    ).toBe(false);
  });

  it("rejects pollState with non-ISO startedAt", () => {
    expect(
      HandlerInputSchema.safeParse({
        jobId: JOB_ID,
        distributionId: DISTRIBUTION_ID,
        previousPoll: {
          status: "in_progress",
          nextWaitSeconds: 30,
          pollState: { startedAt: "yesterday", pollAttempt: 1 },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects succeeded previousPoll (Choice would route this away from the Lambda)", () => {
    expect(
      HandlerInputSchema.safeParse({
        jobId: JOB_ID,
        distributionId: DISTRIBUTION_ID,
        previousPoll: { status: "succeeded", result: {} },
      }).success,
    ).toBe(false);
  });
});

describe("wait-for-cloudfront — first tick", () => {
  it("upserts JobStep running, returns in_progress with pollAttempt=1 when distribution is still InProgress", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { getDistribution, state: gdState } = stubGetDistribution({
      Distribution: { Status: "InProgress" },
    });
    const { now } = stubNow(STARTED_AT_MS);
    const handler = buildHandler({ getDistribution, now });

    const result = await handler(FIRST_TICK_INPUT);

    expect(result).toEqual({
      status: "in_progress",
      nextWaitSeconds: 30,
      pollState: { startedAt: STARTED_AT, pollAttempt: 1 },
    });
    expect(gdState.calls).toEqual([{ Id: DISTRIBUTION_ID }]);
    // Single DDB write — the running upsert. No succeeded/failed yet.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("upserts JobStep succeeded when distribution is already Deployed", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { getDistribution } = stubGetDistribution({
      Distribution: { Status: "Deployed" },
    });
    const { now } = stubNow(STARTED_AT_MS);
    const handler = buildHandler({ getDistribution, now });

    const result = await handler(FIRST_TICK_INPUT);

    expect(result).toEqual({
      status: "succeeded",
      result: {
        distributionId: DISTRIBUTION_ID,
        deployedAt: STARTED_AT,
      },
    });
    // 2 DDB writes: running, then succeeded.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("treats undefined Status as in_progress (still-pending, not error)", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { getDistribution } = stubGetDistribution({ Distribution: {} });
    const { now } = stubNow(STARTED_AT_MS);
    const handler = buildHandler({ getDistribution, now });

    const result = await handler(FIRST_TICK_INPUT);

    expect(result.status).toBe("in_progress");
  });
});

describe("wait-for-cloudfront — subsequent ticks", () => {
  it("preserves startedAt across ticks and increments pollAttempt", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { getDistribution } = stubGetDistribution({
      Distribution: { Status: "InProgress" },
    });
    // 90 seconds after startedAt — still well under budget.
    const { now } = stubNow(STARTED_AT_MS + 90_000);
    const handler = buildHandler({ getDistribution, now });

    const result = await handler(subsequentTickInput(2));

    expect(result).toEqual({
      status: "in_progress",
      nextWaitSeconds: 60,
      pollState: { startedAt: STARTED_AT, pollAttempt: 3 },
    });
    // 0 DDB writes — running was upserted on the first tick; subsequent
    // ticks skip the IO until terminal.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("returns succeeded with deployedAt = now when Status flips to Deployed mid-loop", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { getDistribution } = stubGetDistribution({
      Distribution: { Status: "Deployed" },
    });
    const flipMs = STARTED_AT_MS + 5 * 60_000;
    const { now } = stubNow(flipMs);
    const handler = buildHandler({ getDistribution, now });

    const result = await handler(subsequentTickInput(5));

    expect(result).toEqual({
      status: "succeeded",
      result: {
        distributionId: DISTRIBUTION_ID,
        deployedAt: new Date(flipMs).toISOString(),
      },
    });
    // 1 DDB write — the succeeded transition. No re-running upsert.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("nextWaitSeconds follows the schedule: 30,30,60,60,60,90 then 90 indefinitely", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { getDistribution } = stubGetDistribution({
      Distribution: { Status: "InProgress" },
    });

    // For each tick, completedAttempts -> expected nextWaitSeconds.
    // (justCompletedAttempt index - 1 into the schedule, tail = 90.)
    const expectations: Array<[number, number]> = [
      [0, 30], // first tick (init), justCompleted = 1, schedule[0] = 30
      [1, 30], // schedule[1] = 30
      [2, 60], // schedule[2] = 60
      [3, 60],
      [4, 60],
      [5, 90], // schedule[5] = 90 (last entry)
      [6, 90], // tail
      [10, 90], // tail
    ];

    for (const [completedAttempts, expected] of expectations) {
      const { now } = stubNow(STARTED_AT_MS + completedAttempts * 30_000);
      const handler = buildHandler({ getDistribution, now });
      const input =
        completedAttempts === 0
          ? FIRST_TICK_INPUT
          : subsequentTickInput(completedAttempts);
      const result = await handler(input);
      if (result.status !== "in_progress") {
        throw new Error(`expected in_progress for tick ${completedAttempts}`);
      }
      expect(result.nextWaitSeconds).toBe(expected);
    }
  });
});

describe("wait-for-cloudfront — budget exhaustion", () => {
  it("throws IronforgePollTimeoutError when elapsed exceeds 20 min, marks JobStep failed", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { getDistribution, state: gdState } = stubGetDistribution({
      Distribution: { Status: "InProgress" },
    });
    // 20 min + 1 ms past startedAt.
    const { now } = stubNow(STARTED_AT_MS + 20 * 60_000 + 1);
    const handler = buildHandler({ getDistribution, now });

    await expect(handler(subsequentTickInput(15))).rejects.toBeInstanceOf(
      IronforgePollTimeoutError,
    );

    // Budget check happens BEFORE the GetDistribution call.
    expect(gdState.calls).toHaveLength(0);
    // 1 DDB write — the failed transition.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("does not throw at exactly 20 min minus 1ms", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { getDistribution } = stubGetDistribution({
      Distribution: { Status: "InProgress" },
    });
    const { now } = stubNow(STARTED_AT_MS + 20 * 60_000 - 1);
    const handler = buildHandler({ getDistribution, now });

    const result = await handler(subsequentTickInput(15));
    expect(result.status).toBe("in_progress");
  });
});

describe("wait-for-cloudfront — error paths", () => {
  it("wraps GetDistribution failures in IronforgeWaitForCloudFrontError, marks JobStep failed", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const sdkError = Object.assign(new Error("Not authorized"), {
      name: "AccessDenied",
    });
    const { getDistribution } = stubGetDistribution(sdkError);
    const { now } = stubNow(STARTED_AT_MS);
    const handler = buildHandler({ getDistribution, now });

    await expect(handler(FIRST_TICK_INPUT)).rejects.toBeInstanceOf(
      IronforgeWaitForCloudFrontError,
    );

    // 2 DDB writes: running (first tick) + failed.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("rejects malformed input WITHOUT writing to DDB", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { getDistribution } = stubGetDistribution({ Distribution: {} });
    const { now } = stubNow(STARTED_AT_MS);
    const handler = buildHandler({ getDistribution, now });

    await expect(
      handler({ jobId: "not-a-uuid", distributionId: DISTRIBUTION_ID }),
    ).rejects.toThrow(/schema validation/);

    // No DDB writes — input validation rejects before we touch state.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
