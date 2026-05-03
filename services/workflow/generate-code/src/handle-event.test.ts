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
  installationId: "128963592",
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
  steps: {
    "create-repo": {
      repoFullName: "ironforge-svc/my-site",
      repoUrl: "https://github.com/ironforge-svc/my-site",
      defaultBranch: "main",
      repoId: 42,
      createdAt: "2026-05-02T00:00:00Z",
    },
  },
};

const FIXTURE_FILES = {
  "index.html": "<title>__IRONFORGE_SERVICE_NAME__</title>",
  "README.md": "# __IRONFORGE_SERVICE_NAME__\n\nLive at https://__IRONFORGE_SERVICE_NAME__.__IRONFORGE_DOMAIN__",
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

type StubOctokitParams = {
  getRefResult?: { status?: number; data?: unknown; error?: { status: number } };
  getCommitResult?: { data: unknown };
  createBlobResult?: { data: { sha: string } };
  createTreeResult?: { data: { sha: string } };
  createCommitResult?: { data: { sha: string } };
  createRefResult?: { data: unknown };
  errorOnCreateRef?: { status: number };
};

const stubOctokit = (params: StubOctokitParams = {}) => {
  const calls = {
    getRef: 0,
    getCommit: 0,
    createBlob: 0,
    createTree: 0,
    createCommit: 0,
    createRef: 0,
  };
  const getRef = vi.fn(async () => {
    calls.getRef += 1;
    if (params.getRefResult?.error) throw params.getRefResult.error;
    if (params.getRefResult?.status === undefined && !params.getRefResult?.data) {
      // Default: 404
      throw { status: 404 };
    }
    return { status: 200, data: params.getRefResult!.data };
  });
  const getCommit = vi.fn(async () => {
    calls.getCommit += 1;
    return { status: 200, data: params.getCommitResult?.data };
  });
  const createBlob = vi.fn(async () => {
    calls.createBlob += 1;
    return { data: params.createBlobResult?.data ?? { sha: `blob-${calls.createBlob}` } };
  });
  const createTree = vi.fn(async () => {
    calls.createTree += 1;
    return { data: params.createTreeResult?.data ?? { sha: "tree-sha-aaa" } };
  });
  const createCommit = vi.fn(async () => {
    calls.createCommit += 1;
    return { data: params.createCommitResult?.data ?? { sha: "commit-sha-aaa" } };
  });
  const createRef = vi.fn(async () => {
    calls.createRef += 1;
    if (params.errorOnCreateRef) throw params.errorOnCreateRef;
    return { data: params.createRefResult?.data ?? {} };
  });
  const octokit = {
    rest: {
      git: { getRef, getCommit, createBlob, createTree, createCommit, createRef },
    },
  } as unknown as Parameters<NonNullable<BuildHandlerDeps["buildOctokit"]>>[0] extends infer _
    ? ReturnType<NonNullable<BuildHandlerDeps["buildOctokit"]>>
    : never;
  return { octokit, calls };
};

describe("generate-code handler — happy path (initial commit)", () => {
  it("renders, creates blobs/tree/commit/ref, returns { commitSha, treeSha, fileCount }", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      // refs/heads/main 404 → proceed with create
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      starterCodeFiles: FIXTURE_FILES,
    });

    const result = await handler(VALID_INPUT);

    expect(result.commitSha).toBe("commit-sha-aaa");
    expect(result.treeSha).toBe("tree-sha-aaa");
    expect(result.fileCount).toBe(2);

    expect(calls.getRef).toBe(1);
    expect(calls.getCommit).toBe(0); // No existing ref to inspect
    expect(calls.createBlob).toBe(2); // One per file
    expect(calls.createTree).toBe(1);
    expect(calls.createCommit).toBe(1);
    expect(calls.createRef).toBe(1);

    const ddbCalls = ddbMock.commandCalls(UpdateCommand);
    expect(ddbCalls).toHaveLength(2); // running + succeeded
  });
});

describe("generate-code handler — idempotent retry (ref exists with our jobId)", () => {
  it("returns existing commit's SHAs without creating new blobs/tree/commit/ref", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      getRefResult: {
        data: { object: { sha: "existing-commit-sha" } },
      },
      getCommitResult: {
        data: {
          message: `Add starter code (Ironforge job ${VALID_INPUT.jobId})`,
          tree: { sha: "existing-tree-sha" },
        },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      starterCodeFiles: FIXTURE_FILES,
    });

    const result = await handler(VALID_INPUT);

    expect(result.commitSha).toBe("existing-commit-sha");
    expect(result.treeSha).toBe("existing-tree-sha");
    expect(result.fileCount).toBe(2); // Still reports rendered count

    expect(calls.getRef).toBe(1);
    expect(calls.getCommit).toBe(1);
    expect(calls.createBlob).toBe(0); // No git data API writes
    expect(calls.createCommit).toBe(0);
    expect(calls.createRef).toBe(0);
  });
});

describe("generate-code handler — conflict (ref exists, marker mismatch)", () => {
  it("throws IronforgeRefConflictError when commit message lacks our jobId marker", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      getRefResult: {
        data: { object: { sha: "stranger-commit-sha" } },
      },
      getCommitResult: {
        data: {
          message: "Manually committed by an operator",
          tree: { sha: "stranger-tree-sha" },
        },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      starterCodeFiles: FIXTURE_FILES,
    });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeRefConflictError",
    });

    expect(calls.createBlob).toBe(0);
    const ddbCalls = ddbMock.commandCalls(UpdateCommand);
    expect(ddbCalls[1]!.args[0].input.ExpressionAttributeValues?.[":errorName"]).toBe(
      "IronforgeRefConflictError",
    );
  });

  it("does not leak the stranger commit's SHA into JobStep.errorMessage", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit } = stubOctokit({
      getRefResult: { data: { object: { sha: "leaky-sha-that-shouldnt-appear" } } },
      getCommitResult: {
        data: {
          message: "external commit",
          tree: { sha: "leaky-tree-sha" },
        },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      starterCodeFiles: FIXTURE_FILES,
    });

    await expect(handler(VALID_INPUT)).rejects.toThrow();

    const failed = ddbMock.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(JSON.stringify(failed.ExpressionAttributeValues)).not.toContain(
      "leaky-sha-that-shouldnt-appear",
    );
  });
});

describe("generate-code handler — render failure", () => {
  it("throws IronforgeGenerateError when starter-code references unknown placeholder", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit();
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      starterCodeFiles: {
        "deploy.yml": "role: __IRONFORGE_DEPLOY_ROLE_ARN__",
      },
    });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeGenerateError",
    });

    // No GitHub API calls when render fails
    expect(calls.getRef).toBe(0);
    expect(calls.createBlob).toBe(0);
  });
});

describe("generate-code handler — empty repo (409 from getRef)", () => {
  it("treats 409 as not-found and proceeds with create", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      getRefResult: { error: { status: 409 } },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      starterCodeFiles: FIXTURE_FILES,
    });

    const result = await handler(VALID_INPUT);
    expect(result.commitSha).toBe("commit-sha-aaa");
    expect(calls.createBlob).toBe(2);
  });
});

describe("generate-code handler — missing $.steps.create-repo", () => {
  it("throws IronforgeGenerateError when create-repo step output is absent", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit();
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      starterCodeFiles: FIXTURE_FILES,
    });

    const inputWithoutSteps = { ...VALID_INPUT, steps: undefined };
    await expect(handler(inputWithoutSteps)).rejects.toMatchObject({
      name: "IronforgeGenerateError",
    });

    expect(calls.getRef).toBe(0);
  });

  it("throws IronforgeGenerateError when create-repo output is malformed (missing repoFullName)", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit } = stubOctokit();
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      starterCodeFiles: FIXTURE_FILES,
    });

    const malformed = {
      ...VALID_INPUT,
      steps: { "create-repo": { defaultBranch: "main", repoId: 42 } }, // no repoFullName
    };
    await expect(handler(malformed)).rejects.toMatchObject({
      name: "IronforgeGenerateError",
    });
  });
});

describe("generate-code handler — workflow input parse failure", () => {
  it("throws IronforgeWorkflowInputError before any DDB write", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => stubOctokit().octokit,
      starterCodeFiles: FIXTURE_FILES,
    });

    await expect(handler({ not: "valid" })).rejects.toMatchObject({
      name: "IronforgeWorkflowInputError",
    });

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("generate-code handler — render output content", () => {
  it("substitutes SERVICE_NAME and DOMAIN into rendered files", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const capturedBlobContents: string[] = [];
    const { octokit } = stubOctokit();
    // Wrap createBlob to capture content
    octokit.rest.git.createBlob = vi.fn(async (args: { content: string }) => {
      capturedBlobContents.push(args.content);
      return { data: { sha: `blob-${capturedBlobContents.length}` } };
    }) as unknown as typeof octokit.rest.git.createBlob;

    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      starterCodeFiles: FIXTURE_FILES,
    });

    await handler(VALID_INPUT);

    const titleFile = capturedBlobContents.find((c) => c.startsWith("<title>"));
    expect(titleFile).toBe("<title>my-site</title>");
    const readme = capturedBlobContents.find((c) => c.startsWith("# "));
    expect(readme).toBe(
      "# my-site\n\nLive at https://my-site.ironforge.rickycaballero.com",
    );
  });
});
