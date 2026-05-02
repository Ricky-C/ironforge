import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetConfigCacheForTests,
  buildHandler,
  type BuildHandlerDeps,
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
  orgName: "ironforge-svc",
};

const VALID_INPUT = {
  serviceId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  executionName: "22222222-2222-4222-8222-222222222222",
  serviceName: "my-site",
  ownerId: "33333333-3333-4333-8333-333333333333",
  templateId: "static-site",
  inputs: {},
};

beforeEach(() => {
  ddbMock.reset();
  __resetConfigCacheForTests();
  vi.restoreAllMocks();
});

const stubMintToken = (token = "ghs_test_token") =>
  vi.fn().mockResolvedValue({
    token,
    expiresAt: new Date("2026-05-02T01:00:00Z"),
  });

// Lightweight Octokit stub. Only the surface the handler touches is
// implemented; calls to anything else surface as test failures.
// `status` is optional because the error path doesn't need it (the
// thrown object's status property is what the handler reads).
type FakeRepoResponse = {
  status?: number;
  data?: unknown;
  error?: { status: number; response?: { headers?: Record<string, string> } };
};

type BuildOctokit = NonNullable<BuildHandlerDeps["buildOctokit"]>;
type FakeOctokit = ReturnType<BuildOctokit>;

const stubOctokit = (params: {
  getResult: FakeRepoResponse;
  createResult?: FakeRepoResponse;
}): { octokit: FakeOctokit; calls: { get: number; create: number } } => {
  const calls = { get: 0, create: 0 };
  const get = vi.fn(async () => {
    calls.get += 1;
    if (params.getResult.error) throw params.getResult.error;
    return { status: params.getResult.status ?? 200, data: params.getResult.data };
  });
  const create = vi.fn(async () => {
    calls.create += 1;
    if (params.createResult?.error) throw params.createResult.error;
    return {
      status: params.createResult?.status ?? 201,
      data: params.createResult?.data,
    };
  });
  const octokit = {
    rest: { repos: { get } },
    request: create,
  } as unknown as FakeOctokit;
  return { octokit, calls };
};

const validRepoData = {
  id: 42,
  full_name: "ironforge-svc/my-site",
  html_url: "https://github.com/ironforge-svc/my-site",
  default_branch: "main",
  created_at: "2026-05-02T00:00:00Z",
};

describe("create-repo handler — happy path (repo does not exist)", () => {
  it("creates the repo and writes JobStep running → succeeded with full output", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      getResult: { error: { status: 404 } },
      createResult: {
        status: 201,
        data: {
          ...validRepoData,
          custom_properties: { "ironforge-job-id": VALID_INPUT.jobId },
        },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
    });

    const result = await handler(VALID_INPUT);

    expect(result).toEqual({
      repoFullName: "ironforge-svc/my-site",
      repoUrl: "https://github.com/ironforge-svc/my-site",
      defaultBranch: "main",
      repoId: 42,
      createdAt: "2026-05-02T00:00:00Z",
    });

    expect(calls.get).toBe(1);
    expect(calls.create).toBe(1);

    const ddbCalls = ddbMock.commandCalls(UpdateCommand);
    expect(ddbCalls).toHaveLength(2); // running + succeeded
    expect(ddbCalls[1]!.args[0].input.UpdateExpression).toContain(
      "#status = :succeeded",
    );
  });
});

describe("create-repo handler — idempotent retry (repo exists with our jobId)", () => {
  it("returns the existing repo data without calling create", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      getResult: {
        status: 200,
        data: {
          ...validRepoData,
          custom_properties: { "ironforge-job-id": VALID_INPUT.jobId },
        },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
    });

    const result = await handler(VALID_INPUT);

    expect(result.repoFullName).toBe("ironforge-svc/my-site");
    expect(calls.get).toBe(1);
    expect(calls.create).toBe(0); // No POST — idempotent retry
  });
});

describe("create-repo handler — conflict (repo exists, different jobId)", () => {
  it("throws IronforgeGitHubRepoConflictError and writes JobStep failed", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      getResult: {
        status: 200,
        data: {
          ...validRepoData,
          custom_properties: { "ironforge-job-id": "different-job-id" },
        },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
    });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeGitHubRepoConflictError",
    });

    expect(calls.create).toBe(0); // No POST attempted
    const ddbCalls = ddbMock.commandCalls(UpdateCommand);
    expect(ddbCalls).toHaveLength(2); // running + failed
    expect(ddbCalls[1]!.args[0].input.ExpressionAttributeValues?.[":errorName"]).toBe(
      "IronforgeGitHubRepoConflictError",
    );
    expect(ddbCalls[1]!.args[0].input.ExpressionAttributeValues?.[":retryable"]).toBe(
      false,
    );
  });

  it("does not leak the existing repo's job-id into JobStep.errorMessage", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const otherJobId = "33333333-3333-4333-8333-333333333333";
    const { octokit } = stubOctokit({
      getResult: {
        status: 200,
        data: {
          ...validRepoData,
          custom_properties: { "ironforge-job-id": otherJobId },
        },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
    });

    await expect(handler(VALID_INPUT)).rejects.toThrow();

    const ddbCalls = ddbMock.commandCalls(UpdateCommand);
    const failedCall = ddbCalls[1]!.args[0].input;
    expect(JSON.stringify(failedCall.ExpressionAttributeValues)).not.toContain(
      otherJobId,
    );
  });
});

describe("create-repo handler — rate limit", () => {
  it("throws IronforgeGitHubRateLimitedError on 403 with x-ratelimit-remaining: 0", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit } = stubOctokit({
      getResult: { error: { status: 404 } },
      createResult: {
        error: {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1714694400",
            },
          },
        },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
    });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeGitHubRateLimitedError",
    });

    const ddbCalls = ddbMock.commandCalls(UpdateCommand);
    expect(ddbCalls[1]!.args[0].input.ExpressionAttributeValues?.[":errorName"]).toBe(
      "IronforgeGitHubRateLimitedError",
    );
  });

  it("does not include x-ratelimit-reset in JobStep.errorMessage (sanitization)", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const resetTimestamp = "1714694400";
    const { octokit } = stubOctokit({
      getResult: { error: { status: 404 } },
      createResult: {
        error: {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": resetTimestamp,
            },
          },
        },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
    });

    await expect(handler(VALID_INPUT)).rejects.toThrow();

    const failedCall = ddbMock.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(JSON.stringify(failedCall.ExpressionAttributeValues)).not.toContain(
      resetTimestamp,
    );
  });

  it("treats 403 WITHOUT rate-limit headers as auth error, not rate-limit", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit } = stubOctokit({
      getResult: { error: { status: 404 } },
      createResult: {
        error: { status: 403 }, // No x-ratelimit-remaining header
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
    });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeGitHubAuthError",
    });
  });
});

describe("create-repo handler — provision error fallback", () => {
  it("throws IronforgeGitHubProvisionError on unexpected 5xx from create", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit } = stubOctokit({
      getResult: { error: { status: 404 } },
      createResult: { error: { status: 503 } },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
    });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeGitHubProvisionError",
    });

    const failedCall = ddbMock.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(failedCall.ExpressionAttributeValues?.[":errorName"]).toBe(
      "IronforgeGitHubProvisionError",
    );
  });

  it("throws IronforgeGitHubProvisionError on unexpected 5xx from get", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      getResult: { error: { status: 500 } },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
    });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeGitHubProvisionError",
    });
    expect(calls.create).toBe(0);
  });
});

describe("create-repo handler — workflow input parse failure", () => {
  it("throws IronforgeWorkflowInputError before any DDB write", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => stubOctokit({ getResult: { status: 404 } }).octokit,
    });

    await expect(handler({ not: "valid" })).rejects.toMatchObject({
      name: "IronforgeWorkflowInputError",
    });

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
