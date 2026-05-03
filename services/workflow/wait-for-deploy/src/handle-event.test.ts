import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, IronforgeGitHubAuthError } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  __resetConfigCacheForTests,
  buildHandler,
  HandlerInputSchema,
  IronforgeDeployRunError,
  IronforgePollTimeoutError,
  type ListWorkflowRunsFn,
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

const TEST_CONFIG = {
  secretArn:
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:ironforge/github-app/private-key-AbCdEf",
  appId: "3560881",
  installationId: "128511853",
};

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const CORRELATION_ID = JOB_ID;
const REPO_FULL_NAME = "ironforge-svc/my-site";
const STARTED_AT = "2026-05-03T12:00:00.000Z";
const STARTED_AT_MS = new Date(STARTED_AT).getTime();

const FIRST_TICK_INPUT = {
  jobId: JOB_ID,
  correlationId: CORRELATION_ID,
  repoFullName: REPO_FULL_NAME,
  previousPoll: { status: "init" as const },
};

const subsequentTickInput = (
  pollAttempt: number,
  startedAt = STARTED_AT,
): unknown => ({
  jobId: JOB_ID,
  correlationId: CORRELATION_ID,
  repoFullName: REPO_FULL_NAME,
  previousPoll: {
    status: "in_progress" as const,
    nextWaitSeconds: 30,
    pollState: { startedAt, pollAttempt },
  },
});

beforeEach(() => {
  ddbMock.reset();
  __resetConfigCacheForTests();
  vi.restoreAllMocks();
});

const stubMintToken = (token = "ghs_test_token") =>
  vi.fn().mockResolvedValue({
    token,
    expiresAt: new Date("2026-05-03T13:00:00Z"),
  });

type RunSummary = {
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  updated_at: string;
};

const stubListRuns = (
  result: RunSummary | null | Error,
): { listWorkflowRuns: ListWorkflowRunsFn; calls: Array<{ owner: string; repo: string; correlationId: string }> } => {
  const calls: Array<{ owner: string; repo: string; correlationId: string }> = [];
  const listWorkflowRuns: ListWorkflowRunsFn = async (params) => {
    calls.push(params);
    if (result instanceof Error) throw result;
    return result;
  };
  return { listWorkflowRuns, calls };
};

describe("HandlerInputSchema", () => {
  it("accepts the focused shape from SFN Parameters", () => {
    expect(HandlerInputSchema.safeParse(FIRST_TICK_INPUT).success).toBe(true);
  });

  it("accepts subsequent-tick input with pollState carry-forward", () => {
    expect(
      HandlerInputSchema.safeParse(subsequentTickInput(2)).success,
    ).toBe(true);
  });

  it("rejects malformed repoFullName (no slash)", () => {
    expect(
      HandlerInputSchema.safeParse({
        ...FIRST_TICK_INPUT,
        repoFullName: "no-slash",
      }).success,
    ).toBe(false);
  });

  it("rejects empty correlationId", () => {
    expect(
      HandlerInputSchema.safeParse({ ...FIRST_TICK_INPUT, correlationId: "" })
        .success,
    ).toBe(false);
  });
});

describe("wait-for-deploy — first tick", () => {
  it("returns in_progress when run not yet visible (workflow_dispatch async lag)", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns } = stubListRuns(null);
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS,
    });

    const result = await handler(FIRST_TICK_INPUT);

    expect(result).toEqual({
      status: "in_progress",
      nextWaitSeconds: 30,
      pollState: { startedAt: STARTED_AT, pollAttempt: 1 },
    });
    // 1 DDB write — running upsert.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("returns in_progress when matching run is queued", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns } = stubListRuns({
      id: 999,
      name: `Deploy [${CORRELATION_ID}]`,
      status: "queued",
      conclusion: null,
      html_url: "https://github.com/ironforge-svc/my-site/actions/runs/999",
      updated_at: STARTED_AT,
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS,
    });

    const result = await handler(FIRST_TICK_INPUT);

    expect(result.status).toBe("in_progress");
  });

  it("returns succeeded when matching run is completed=success on first tick", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns } = stubListRuns({
      id: 999,
      name: `Deploy [${CORRELATION_ID}]`,
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/ironforge-svc/my-site/actions/runs/999",
      updated_at: "2026-05-03T12:00:30.000Z",
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS,
    });

    const result = await handler(FIRST_TICK_INPUT);

    expect(result).toEqual({
      status: "succeeded",
      result: {
        runId: 999,
        runUrl: "https://github.com/ironforge-svc/my-site/actions/runs/999",
        conclusion: "success",
        completedAt: "2026-05-03T12:00:30.000Z",
      },
    });
    // 2 DDB writes: running + succeeded.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("passes correlationId through to listWorkflowRuns", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns, calls } = stubListRuns(null);
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS,
    });

    await handler(FIRST_TICK_INPUT);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      owner: "ironforge-svc",
      repo: "my-site",
      correlationId: CORRELATION_ID,
    });
  });
});

describe("wait-for-deploy — subsequent ticks", () => {
  it("preserves startedAt and increments pollAttempt", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns } = stubListRuns({
      id: 999,
      name: `Deploy [${CORRELATION_ID}]`,
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/ironforge-svc/my-site/actions/runs/999",
      updated_at: STARTED_AT,
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS + 60_000,
    });

    const result = await handler(subsequentTickInput(2));

    expect(result).toEqual({
      status: "in_progress",
      nextWaitSeconds: 60,
      pollState: { startedAt: STARTED_AT, pollAttempt: 3 },
    });
    // 0 DDB writes — running was upserted on first tick; subsequent
    // in_progress ticks skip IO.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("nextWaitSeconds follows the wait-for-cloudfront schedule", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns } = stubListRuns({
      id: 999,
      name: `Deploy [${CORRELATION_ID}]`,
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/ironforge-svc/my-site/actions/runs/999",
      updated_at: STARTED_AT,
    });

    const expectations: Array<[number, number]> = [
      [0, 30],
      [1, 30],
      [2, 60],
      [3, 60],
      [4, 60],
      [5, 90],
      [10, 90],
    ];

    for (const [completedAttempts, expected] of expectations) {
      const handler = buildHandler({
        config: TEST_CONFIG,
        getInstallationToken: stubMintToken(),
        buildOctokit: () => ({}) as never,
        listWorkflowRuns,
        now: () => STARTED_AT_MS + completedAttempts * 30_000,
      });
      const input =
        completedAttempts === 0
          ? FIRST_TICK_INPUT
          : subsequentTickInput(completedAttempts);
      const result = await handler(input);
      if (result.status !== "in_progress") {
        throw new Error(`expected in_progress at attempt ${completedAttempts}`);
      }
      expect(result.nextWaitSeconds).toBe(expected);
    }
  });
});

describe("wait-for-deploy — terminal failures", () => {
  it("throws IronforgeDeployRunError on conclusion=failure", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns } = stubListRuns({
      id: 999,
      name: `Deploy [${CORRELATION_ID}]`,
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/ironforge-svc/my-site/actions/runs/999",
      updated_at: "2026-05-03T12:01:00.000Z",
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS,
    });

    await expect(handler(FIRST_TICK_INPUT)).rejects.toBeInstanceOf(
      IronforgeDeployRunError,
    );
    // 2 DDB writes: running + failed.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("throws IronforgeDeployRunError on conclusion=cancelled", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns } = stubListRuns({
      id: 999,
      name: `Deploy [${CORRELATION_ID}]`,
      status: "completed",
      conclusion: "cancelled",
      html_url: "https://github.com/ironforge-svc/my-site/actions/runs/999",
      updated_at: "2026-05-03T12:01:00.000Z",
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS,
    });

    await expect(handler(FIRST_TICK_INPUT)).rejects.toBeInstanceOf(
      IronforgeDeployRunError,
    );
  });
});

describe("wait-for-deploy — budget exhaustion", () => {
  it("throws IronforgePollTimeoutError when elapsed exceeds 10 min", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns, calls } = stubListRuns({
      id: 999,
      name: `Deploy [${CORRELATION_ID}]`,
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/ironforge-svc/my-site/actions/runs/999",
      updated_at: STARTED_AT,
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS + 10 * 60_000 + 1,
    });

    await expect(handler(subsequentTickInput(10))).rejects.toBeInstanceOf(
      IronforgePollTimeoutError,
    );
    // Budget check happens BEFORE the listWorkflowRuns call.
    expect(calls).toHaveLength(0);
    // 1 DDB write — failed transition (no first-tick running upsert
    // because previousPoll.status is in_progress).
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });
});

describe("wait-for-deploy — error paths", () => {
  it("401 from listWorkflowRuns wraps to IronforgeGitHubAuthError, marks JobStep failed", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const sdkError = Object.assign(new Error("Bad credentials"), {
      status: 401,
    });
    const { listWorkflowRuns } = stubListRuns(sdkError);
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS,
    });

    await expect(handler(FIRST_TICK_INPUT)).rejects.toBeInstanceOf(
      IronforgeGitHubAuthError,
    );
    // 2 DDB writes: running + failed.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("rejects malformed input WITHOUT writing to DDB or calling Octokit", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { listWorkflowRuns, calls } = stubListRuns(null);
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => ({}) as never,
      listWorkflowRuns,
      now: () => STARTED_AT_MS,
    });

    await expect(
      handler({ ...FIRST_TICK_INPUT, repoFullName: "no-slash" }),
    ).rejects.toThrow(/schema validation/);

    expect(calls).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
