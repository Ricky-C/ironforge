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
  IronforgeRepoSecretError,
  IronforgeWorkflowDispatchError,
  type BuildHandlerDeps,
  type EncryptSecretFn,
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
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";

const VALID_INPUT = {
  jobId: JOB_ID,
  serviceId: SERVICE_ID,
  repoFullName: "ironforge-svc/my-site",
  defaultBranch: "main",
  deployRoleArn:
    "arn:aws:iam::123456789012:role/ironforge-svc-my-site-deploy",
  bucketName: "ironforge-svc-my-site-origin",
  distributionId: "E1ABC123XYZ",
};

const FAKE_PUBLIC_KEY_B64 = "ZmFrZXB1YmxpY2tleQ==";
const FAKE_KEY_ID = "key-id-123";

beforeEach(() => {
  ddbMock.reset();
  __resetConfigCacheForTests();
  vi.restoreAllMocks();
});

const stubMintToken = (token = "ghs_test_token") =>
  vi.fn().mockResolvedValue({
    token,
    expiresAt: new Date("2026-05-03T01:00:00Z"),
  });

// Deterministic encrypt-stub: returns "enc(<value>)" so tests can assert
// per-secret encryption + Octokit-passthrough without booting WASM.
const stubEncryptSecret: EncryptSecretFn = async ({ value }) =>
  `enc(${value})`;

type GetPublicKeyCall = { owner: string; repo: string };
type SetSecretCall = {
  owner: string;
  repo: string;
  secret_name: string;
  encrypted_value: string;
  key_id: string;
};
type DispatchCall = {
  owner: string;
  repo: string;
  workflow_id: string;
  ref: string;
  inputs?: Record<string, string>;
};

type FakeOctokit = NonNullable<BuildHandlerDeps["buildOctokit"]>;
type StubOctokitResult = {
  octokit: ReturnType<FakeOctokit>;
  calls: {
    getPublicKey: GetPublicKeyCall[];
    setSecret: SetSecretCall[];
    dispatch: DispatchCall[];
  };
};

type StubOctokitConfig = {
  getPublicKeyError?: { status: number; response?: { headers?: Record<string, string> } };
  setSecretError?: {
    onSecretName?: string;
    error: { status: number; response?: { headers?: Record<string, string> } };
  };
  dispatchError?: { status: number; response?: { headers?: Record<string, string> } };
};

const stubOctokit = (config: StubOctokitConfig = {}): StubOctokitResult => {
  const calls: StubOctokitResult["calls"] = {
    getPublicKey: [],
    setSecret: [],
    dispatch: [],
  };
  const getRepoPublicKey = vi.fn(async (params: GetPublicKeyCall) => {
    calls.getPublicKey.push(params);
    if (config.getPublicKeyError) throw config.getPublicKeyError;
    return {
      status: 200,
      data: { key: FAKE_PUBLIC_KEY_B64, key_id: FAKE_KEY_ID },
    };
  });
  const createOrUpdateRepoSecret = vi.fn(async (params: SetSecretCall) => {
    calls.setSecret.push(params);
    if (
      config.setSecretError &&
      (config.setSecretError.onSecretName === undefined ||
        params.secret_name === config.setSecretError.onSecretName)
    ) {
      throw config.setSecretError.error;
    }
    return { status: 204 };
  });
  const createWorkflowDispatch = vi.fn(async (params: DispatchCall) => {
    calls.dispatch.push(params);
    if (config.dispatchError) throw config.dispatchError;
    return { status: 204 };
  });
  const octokit = {
    rest: {
      actions: {
        getRepoPublicKey,
        createOrUpdateRepoSecret,
        createWorkflowDispatch,
      },
    },
  } as unknown as ReturnType<FakeOctokit>;
  return { octokit, calls };
};

describe("HandlerInputSchema", () => {
  it("accepts the focused shape SFN's Parameters block constructs", () => {
    expect(HandlerInputSchema.safeParse(VALID_INPUT).success).toBe(true);
  });

  it("rejects malformed repoFullName (no slash)", () => {
    expect(
      HandlerInputSchema.safeParse({ ...VALID_INPUT, repoFullName: "bad" })
        .success,
    ).toBe(false);
  });

  it("rejects malformed repoFullName (extra slash)", () => {
    expect(
      HandlerInputSchema.safeParse({
        ...VALID_INPUT,
        repoFullName: "a/b/c",
      }).success,
    ).toBe(false);
  });

  it("rejects empty defaultBranch", () => {
    expect(
      HandlerInputSchema.safeParse({ ...VALID_INPUT, defaultBranch: "" }).success,
    ).toBe(false);
  });
});

describe("trigger-deploy — happy path", () => {
  it("fetches public key, sets 3 secrets in order, fires dispatch with correlation_id", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit();
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      encryptSecret: stubEncryptSecret,
      now: () => new Date("2026-05-03T12:00:00Z").getTime(),
    });

    const result = await handler(VALID_INPUT);

    expect(result).toEqual({
      correlationId: JOB_ID,
      repoFullName: "ironforge-svc/my-site",
      workflowFile: "deploy.yml",
      dispatchedAt: "2026-05-03T12:00:00.000Z",
    });

    // 1 public-key fetch + 3 secret sets + 1 dispatch.
    expect(calls.getPublicKey).toHaveLength(1);
    expect(calls.setSecret).toHaveLength(3);
    expect(calls.dispatch).toHaveLength(1);

    // Secret order: DEPLOY_ROLE_ARN → BUCKET_NAME → DISTRIBUTION_ID.
    expect(calls.setSecret.map((c) => c.secret_name)).toEqual([
      "IRONFORGE_DEPLOY_ROLE_ARN",
      "IRONFORGE_BUCKET_NAME",
      "IRONFORGE_DISTRIBUTION_ID",
    ]);

    // Each secret encrypted via the stub: enc(<value>).
    expect(calls.setSecret[0]!.encrypted_value).toBe(
      "enc(arn:aws:iam::123456789012:role/ironforge-svc-my-site-deploy)",
    );
    expect(calls.setSecret[1]!.encrypted_value).toBe(
      "enc(ironforge-svc-my-site-origin)",
    );
    expect(calls.setSecret[2]!.encrypted_value).toBe("enc(E1ABC123XYZ)");

    // All secrets share the same key_id (one public-key fetch).
    expect(
      calls.setSecret.every((c) => c.key_id === FAKE_KEY_ID),
    ).toBe(true);

    // Dispatch wires correlation_id to jobId; targets deploy.yml on the
    // repo's default branch.
    expect(calls.dispatch[0]).toEqual({
      owner: "ironforge-svc",
      repo: "my-site",
      workflow_id: "deploy.yml",
      ref: "main",
      inputs: { correlation_id: JOB_ID },
    });

    // 2 DDB writes: running, then succeeded.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("sets all 3 secrets BEFORE firing the dispatch (ordering invariant)", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit();

    // Wrap the dispatch to verify it sees all 3 secrets already set.
    const originalDispatch = octokit.rest.actions.createWorkflowDispatch;
    let secretsSetWhenDispatchCalled = -1;
    octokit.rest.actions.createWorkflowDispatch = (async (
      params: Parameters<typeof originalDispatch>[0],
    ) => {
      secretsSetWhenDispatchCalled = calls.setSecret.length;
      return originalDispatch(params);
    }) as typeof originalDispatch;

    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      encryptSecret: stubEncryptSecret,
      now: () => 0,
    });

    await handler(VALID_INPUT);

    expect(secretsSetWhenDispatchCalled).toBe(3);
  });
});

describe("trigger-deploy — error paths", () => {
  it("auth failure on getRepoPublicKey throws IronforgeGitHubAuthError, no secrets set, no dispatch", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      getPublicKeyError: { status: 401 },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      encryptSecret: stubEncryptSecret,
      now: () => 0,
    });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeGitHubAuthError,
    );
    expect(calls.setSecret).toHaveLength(0);
    expect(calls.dispatch).toHaveLength(0);
    // 2 DDB writes: running + failed.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
  });

  it("500 on first secret throws IronforgeRepoSecretError, no further secrets, no dispatch", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      setSecretError: {
        onSecretName: "IRONFORGE_DEPLOY_ROLE_ARN",
        error: { status: 500 },
      },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      encryptSecret: stubEncryptSecret,
      now: () => 0,
    });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeRepoSecretError,
    );
    // First secret attempted; subsequent ones never tried.
    expect(calls.setSecret).toHaveLength(1);
    expect(calls.setSecret[0]!.secret_name).toBe("IRONFORGE_DEPLOY_ROLE_ARN");
    expect(calls.dispatch).toHaveLength(0);
  });

  it("500 on dispatch throws IronforgeWorkflowDispatchError after secrets are set", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit({
      dispatchError: { status: 500 },
    });
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      encryptSecret: stubEncryptSecret,
      now: () => 0,
    });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeWorkflowDispatchError,
    );
    expect(calls.setSecret).toHaveLength(3);
    expect(calls.dispatch).toHaveLength(1);
  });

  it("rejects malformed input WITHOUT writing to DDB or calling Octokit", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { octokit, calls } = stubOctokit();
    const handler = buildHandler({
      config: TEST_CONFIG,
      getInstallationToken: stubMintToken(),
      buildOctokit: () => octokit,
      encryptSecret: stubEncryptSecret,
      now: () => 0,
    });

    await expect(
      handler({ ...VALID_INPUT, repoFullName: "no-slash" }),
    ).rejects.toThrow(/schema validation/);

    expect(calls.getPublicKey).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
