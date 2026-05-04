import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
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
  buildHandler,
  HandlerInputSchema,
  IronforgeDeprovisionExternalResourcesError,
  IronforgeWorkflowInputError,
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
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_NAME = "my-site";
const ARCHIVED_AT_MS = new Date("2026-05-04T12:00:00.000Z").getTime();
const ARCHIVED_AT_ISO = "2026-05-04T12:00:00.000Z";

const VALID_INPUT = {
  jobId: JOB_ID,
  serviceId: SERVICE_ID,
  serviceName: SERVICE_NAME,
};

const FIXED_ENV = {
  githubOrg: "ironforge-svc",
  githubAppSecretArn: "arn:aws:secretsmanager:us-east-1:000:secret:gh-app",
  githubAppId: "12345",
  githubAppInstallationId: "67890",
  tfstateBucket: "ironforge-dev-tfstate",
};

const conditionFailed = (): Error =>
  new ConditionalCheckFailedException({
    $metadata: {},
    message: "The conditional request failed",
  });

// Build a destroy-chain dep set from per-test stubs. Defaults to
// happy-path "deleted".
const happyChain = () => ({
  deleteGithubRepo: vi
    .fn()
    .mockResolvedValue({ status: "succeeded", durationMs: 5, detail: "deleted" }),
  deleteTfstate: vi
    .fn()
    .mockResolvedValue({ status: "succeeded", durationMs: 3, detail: "deleted" }),
});

const buildTestHandler = (
  override?: Partial<{
    chain: ReturnType<typeof happyChain>;
    now: () => number;
  }>,
) =>
  buildHandler({
    now: override?.now ?? (() => ARCHIVED_AT_MS),
    destroyChain: override?.chain ?? happyChain(),
    readEnv: () => FIXED_ENV,
  });

describe("HandlerInputSchema", () => {
  it("accepts the focused {jobId, serviceId, serviceName} shape", () => {
    expect(HandlerInputSchema.safeParse(VALID_INPUT).success).toBe(true);
  });

  it("rejects malformed jobId", () => {
    expect(
      HandlerInputSchema.safeParse({ ...VALID_INPUT, jobId: "not-a-uuid" })
        .success,
    ).toBe(false);
  });

  it("rejects uppercase serviceName (DNS-label rules)", () => {
    expect(
      HandlerInputSchema.safeParse({ ...VALID_INPUT, serviceName: "MySite" })
        .success,
    ).toBe(false);
  });
});

describe("delete-external-resources — happy path", () => {
  it("deletes both resources, transitions Service+Job, returns archivedAt + outcome details, writes 4 DDB updates", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const chain = happyChain();
    const handler = buildTestHandler({ chain });

    const result = await handler(VALID_INPUT);

    expect(result).toEqual({
      archivedAt: ARCHIVED_AT_ISO,
      github: { detail: "deleted" },
      tfstate: { detail: "deleted" },
    });

    // Both destroy-chain primitives invoked once.
    expect(chain.deleteGithubRepo).toHaveBeenCalledTimes(1);
    expect(chain.deleteGithubRepo).toHaveBeenCalledWith({
      owner: FIXED_ENV.githubOrg,
      repo: SERVICE_NAME,
      appAuth: {
        secretArn: FIXED_ENV.githubAppSecretArn,
        appId: FIXED_ENV.githubAppId,
        installationId: FIXED_ENV.githubAppInstallationId,
      },
    });
    expect(chain.deleteTfstate).toHaveBeenCalledTimes(1);
    expect(chain.deleteTfstate).toHaveBeenCalledWith({
      tfstateBucket: FIXED_ENV.tfstateBucket,
      serviceId: SERVICE_ID,
    });

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(4); // JobStep running, Service, Job, JobStep succeeded

    const serviceUpdate = updates[1]!.args[0].input;
    expect(serviceUpdate.ExpressionAttributeValues?.[":from"]).toBe(
      "deprovisioning",
    );
    expect(serviceUpdate.ExpressionAttributeValues?.[":to"]).toBe("archived");
    const serviceVals = Object.values(
      serviceUpdate.ExpressionAttributeValues ?? {},
    );
    expect(serviceVals).toContain(null); // currentJobId cleared
    expect(serviceVals).toContain(ARCHIVED_AT_ISO);

    const jobUpdate = updates[2]!.args[0].input;
    expect(jobUpdate.ExpressionAttributeValues?.[":from"]).toBe("running");
    expect(jobUpdate.ExpressionAttributeValues?.[":to"]).toBe("succeeded");

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("propagates already-absent details into the output", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const chain = {
      deleteGithubRepo: vi.fn().mockResolvedValue({
        status: "succeeded",
        durationMs: 1,
        detail: "already-absent",
      }),
      deleteTfstate: vi.fn().mockResolvedValue({
        status: "succeeded",
        durationMs: 1,
        detail: "already-absent",
      }),
    };
    const handler = buildTestHandler({ chain });

    const result = await handler(VALID_INPUT);

    expect(result.github.detail).toBe("already-absent");
    expect(result.tfstate.detail).toBe("already-absent");
  });
});

describe("delete-external-resources — destroy-chain failure", () => {
  it("throws DeprovisionError on github failure, marks JobStep failed, does NOT call tfstate", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const chain = {
      deleteGithubRepo: vi.fn().mockResolvedValue({
        status: "failed",
        durationMs: 2,
        httpStatus: 403,
        error: "Resource not accessible",
      }),
      deleteTfstate: vi.fn(),
    };
    const handler = buildTestHandler({ chain });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeDeprovisionExternalResourcesError,
    );

    expect(chain.deleteTfstate).not.toHaveBeenCalled();

    // 2 DDB updates: JobStep running + JobStep failed (no Service/Job
    // transitions because we threw before reaching them).
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(2);
    expect(updates[1]!.args[0].input.UpdateExpression).toContain(
      "#status = :failed",
    );
  });

  it("throws DeprovisionError on tfstate failure (after github succeeded)", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const chain = {
      deleteGithubRepo: vi.fn().mockResolvedValue({
        status: "succeeded",
        durationMs: 5,
        detail: "deleted",
      }),
      deleteTfstate: vi.fn().mockResolvedValue({
        status: "failed",
        durationMs: 1,
        error: "AccessDenied",
      }),
    };
    const handler = buildTestHandler({ chain });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeDeprovisionExternalResourcesError,
    );

    expect(chain.deleteGithubRepo).toHaveBeenCalledTimes(1);
    expect(chain.deleteTfstate).toHaveBeenCalledTimes(1);
  });

  it("DeprovisionError context carries operator-triage fields on github failure", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const chain = {
      deleteGithubRepo: vi.fn().mockResolvedValue({
        status: "failed",
        durationMs: 2,
        httpStatus: 403,
        error: "Resource not accessible",
      }),
      deleteTfstate: vi.fn(),
    };
    const handler = buildTestHandler({ chain });

    try {
      await handler(VALID_INPUT);
      throw new Error("expected handler to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IronforgeDeprovisionExternalResourcesError);
      const ctx = (err as IronforgeDeprovisionExternalResourcesError).context;
      expect(ctx).toMatchObject({
        phase: "deleteGithubRepo",
        jobId: JOB_ID,
        serviceId: SERVICE_ID,
        repo: SERVICE_NAME,
      });
    }
  });
});

describe("delete-external-resources — Service idempotent retry", () => {
  it("Service conditional fails but state is archived → continues", async () => {
    // 1st update: JobStep running ok. 2nd: Service transition throws
    // ConditionalCheckFailed. transitionStatus does its own GetItem to
    // read the current status, then our inspectService GetItem confirms
    // the archived state — 2 GetItem calls total on the recovery path.
    // 3rd: Job transition ok. 4th: JobStep succeeded ok.
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({})
      .rejectsOnce(conditionFailed())
      .resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: { status: "archived", currentJobId: null },
    });

    const handler = buildTestHandler();
    const result = await handler(VALID_INPUT);

    expect(result.archivedAt).toBe(ARCHIVED_AT_ISO);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it("Service in unexpected state (still deprovisioning) → throws", async () => {
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({})
      .rejectsOnce(conditionFailed())
      .resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: { status: "deprovisioning", currentJobId: JOB_ID },
    });

    const handler = buildTestHandler();
    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeDeprovisionExternalResourcesError,
    );
  });
});

describe("delete-external-resources — Job idempotent retry", () => {
  it("Job conditional fails but state is succeeded → returns", async () => {
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({}) // JobStep running
      .resolvesOnce({}) // Service transition
      .rejectsOnce(conditionFailed()) // Job transition fails
      .resolves({}); // JobStep succeeded
    // transitionStatus internal GetItem + our inspectJob = 2 calls.
    ddbMock.on(GetCommand).resolves({
      Item: { status: "succeeded" },
    });

    const handler = buildTestHandler();
    const result = await handler(VALID_INPUT);

    expect(result.archivedAt).toBe(ARCHIVED_AT_ISO);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it("Job in unexpected state → throws", async () => {
    ddbMock
      .on(UpdateCommand)
      .resolvesOnce({})
      .resolvesOnce({})
      .rejectsOnce(conditionFailed())
      .resolves({});
    ddbMock.on(GetCommand).resolves({
      Item: { status: "running" }, // didn't actually transition
    });

    const handler = buildTestHandler();
    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeDeprovisionExternalResourcesError,
    );
  });
});

describe("delete-external-resources — input validation", () => {
  it("throws IronforgeWorkflowInputError on schema mismatch and never calls destroy chain", async () => {
    const chain = happyChain();
    const handler = buildTestHandler({ chain });

    await expect(handler({ not: "valid" })).rejects.toBeInstanceOf(
      IronforgeWorkflowInputError,
    );

    expect(chain.deleteGithubRepo).not.toHaveBeenCalled();
    expect(chain.deleteTfstate).not.toHaveBeenCalled();
    // No DDB writes either — schema rejection happens before JobStep
    // running upsert because we don't have a validated jobId yet.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
