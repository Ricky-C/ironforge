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
  vi,
} from "vitest";

import {
  __resetConfigCacheForTests,
  buildHandler,
  IronforgeTerraformApplyError,
  IronforgeTerraformInitError,
  IronforgeTerraformOutputError,
  type FsOps,
  type SpawnArgs,
  type SpawnResult,
  type SpawnTerraform,
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
  templatePath: "/opt/templates",
  tfstateBucket: "ironforge-tfstate-dev-123456789012",
  tfstateKmsKeyArn:
    "arn:aws:kms:us-east-1:123456789012:key/aaaa1111-2222-3333-4444-555566667777",
  awsAccountId: "123456789012",
  ironforgeEnv: "dev",
  ironforgeDomain: "ironforge.rickycaballero.com",
  hostedZoneId: "Z03347273BU8YRR3DL6PF",
  wildcardCertArn:
    "arn:aws:acm:us-east-1:123456789012:certificate/ffff0000-1111-2222-3333-444455556666",
  githubOrg: "ironforge-svc",
  githubOidcProviderArn:
    "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
  permissionBoundaryArn:
    "arn:aws:iam::123456789012:policy/IronforgePermissionBoundary",
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

const VALID_OUTPUT_JSON = {
  bucket_name: {
    value: "ironforge-svc-my-site-origin",
    type: "string",
    sensitive: false,
  },
  distribution_id: {
    value: "E1ABC123XYZ",
    type: "string",
    sensitive: false,
  },
  distribution_domain_name: {
    value: "d1234abcd.cloudfront.net",
    type: "string",
    sensitive: false,
  },
  deploy_role_arn: {
    value: "arn:aws:iam::123456789012:role/ironforge-svc-my-site-deploy",
    type: "string",
    sensitive: false,
  },
  live_url: {
    value: "https://my-site.ironforge.rickycaballero.com",
    type: "string",
    sensitive: false,
  },
  fqdn: {
    value: "my-site.ironforge.rickycaballero.com",
    type: "string",
    sensitive: false,
  },
};

// Records each spawn call's args + cwd + env. Tests assert against
// recorded calls; the seam returns whatever results the test stages.
type StubSpawnState = {
  calls: SpawnArgs[];
  results: SpawnResult[];
};

const stubSpawn = (results: SpawnResult[]): {
  spawnTerraform: SpawnTerraform;
  state: StubSpawnState;
} => {
  const state: StubSpawnState = { calls: [], results };
  let nextResult = 0;
  const spawnTerraform: SpawnTerraform = async (args) => {
    state.calls.push(args);
    const result = results[nextResult];
    nextResult += 1;
    if (result === undefined) {
      throw new Error(
        `stubSpawn ran out of results (calls=${state.calls.length}, staged=${results.length})`,
      );
    }
    return result;
  };
  return { spawnTerraform, state };
};

const successResult = (stdout = ""): SpawnResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});

const failureResult = (stderr: string, exitCode = 1): SpawnResult => ({
  stdout: "",
  stderr,
  exitCode,
});

// FsOps stub that records writeFile contents. mkdir + rm are no-ops that
// resolve. Tests assert on captured writes.
type StubFsState = {
  writes: Array<{ path: string; content: string }>;
  mkdirCalls: string[];
  rmCalls: string[];
  rmErr?: Error;
};

const stubFsOps = (
  rmErr?: Error,
): { fsOps: FsOps; state: StubFsState } => {
  const state: StubFsState = {
    writes: [],
    mkdirCalls: [],
    rmCalls: [],
    ...(rmErr !== undefined ? { rmErr } : {}),
  };
  const fsOps: FsOps = {
    mkdir: async (path) => {
      state.mkdirCalls.push(path);
    },
    writeFile: async (path, content) => {
      state.writes.push({ path, content });
    },
    rm: async (path) => {
      state.rmCalls.push(path);
      if (state.rmErr !== undefined) throw state.rmErr;
    },
  };
  return { fsOps, state };
};

beforeEach(() => {
  ddbMock.reset();
  __resetConfigCacheForTests();
  vi.restoreAllMocks();
});

describe("run-terraform handler — happy path", () => {
  it("init → apply → output → succeeded JobStep with parsed outputs", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform, state: spawnState } = stubSpawn([
      successResult(), // init
      successResult(), // apply
      successResult(JSON.stringify(VALID_OUTPUT_JSON)), // output
    ]);
    const { fsOps, state: fsState } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    const result = await handler(VALID_INPUT);

    expect(result).toEqual({
      bucket_name: "ironforge-svc-my-site-origin",
      distribution_id: "E1ABC123XYZ",
      distribution_domain_name: "d1234abcd.cloudfront.net",
      deploy_role_arn:
        "arn:aws:iam::123456789012:role/ironforge-svc-my-site-deploy",
      live_url: "https://my-site.ironforge.rickycaballero.com",
      fqdn: "my-site.ironforge.rickycaballero.com",
    });

    // 3 terraform invocations: init, apply, output.
    expect(spawnState.calls).toHaveLength(3);
    expect(spawnState.calls[0]!.args[0]).toBe("init");
    expect(spawnState.calls[1]!.args[0]).toBe("apply");
    expect(spawnState.calls[2]!.args[0]).toBe("output");

    // 2 DDB writes — running, then succeeded.
    const ddbCalls = ddbMock.commandCalls(UpdateCommand);
    expect(ddbCalls).toHaveLength(2);

    // Workdir cleanup happens.
    expect(fsState.rmCalls).toEqual([`/test-tmp/${VALID_INPUT.jobId}`]);
  });

  it("passes per-service backend config flags to terraform init", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform, state } = stubSpawn([
      successResult(),
      successResult(),
      successResult(JSON.stringify(VALID_OUTPUT_JSON)),
    ]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await handler(VALID_INPUT);

    const initArgs = state.calls[0]!.args;
    expect(initArgs).toContain(
      `-backend-config=bucket=${TEST_CONFIG.tfstateBucket}`,
    );
    expect(initArgs).toContain(
      `-backend-config=key=services/${VALID_INPUT.serviceId}/terraform.tfstate`,
    );
    expect(initArgs).toContain("-backend-config=region=us-east-1");
    expect(initArgs).toContain("-backend-config=encrypt=true");
    expect(initArgs).toContain(
      `-backend-config=kms_key_id=${TEST_CONFIG.tfstateKmsKeyArn}`,
    );
  });

  it("writes wrapper main.tf + tfvars.json + .terraformrc with expected content", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform } = stubSpawn([
      successResult(),
      successResult(),
      successResult(JSON.stringify(VALID_OUTPUT_JSON)),
    ]);
    const { fsOps, state: fsState } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await handler(VALID_INPUT);

    const writes = Object.fromEntries(fsState.writes.map((w) => [w.path, w.content]));
    const mainTf = writes[`/test-tmp/${VALID_INPUT.jobId}/main.tf`];
    expect(mainTf).toBeDefined();
    expect(mainTf).toContain('source = "/opt/templates/static-site/terraform"');
    expect(mainTf).toContain("backend \"s3\" {}");
    expect(mainTf).toContain("aws.us_east_1 = aws.us_east_1");
    expect(mainTf).toContain("output \"bucket_name\"");
    expect(mainTf).toContain("output \"fqdn\"");

    const tfvars = JSON.parse(
      writes[`/test-tmp/${VALID_INPUT.jobId}/terraform.tfvars.json`]!,
    );
    expect(tfvars).toEqual({
      service_name: "my-site",
      service_id: VALID_INPUT.serviceId,
      owner_id: VALID_INPUT.ownerId,
      environment: TEST_CONFIG.ironforgeEnv,
      aws_account_id: TEST_CONFIG.awsAccountId,
      wildcard_cert_arn: TEST_CONFIG.wildcardCertArn,
      hosted_zone_id: TEST_CONFIG.hostedZoneId,
      domain_name: TEST_CONFIG.ironforgeDomain,
      github_org: TEST_CONFIG.githubOrg,
      github_oidc_provider_arn: TEST_CONFIG.githubOidcProviderArn,
      permission_boundary_arn: TEST_CONFIG.permissionBoundaryArn,
    });

    const cliConfig = writes["/tmp/.terraformrc"];
    expect(cliConfig).toContain("filesystem_mirror");
    expect(cliConfig).toContain("/opt/.terraform.d/plugins");
    expect(cliConfig).toContain("registry.terraform.io/hashicorp/aws");
    expect(cliConfig).toContain('exclude = ["registry.terraform.io/*/*"]');
  });

  it("threads TF_CLI_CONFIG_FILE + TF_IN_AUTOMATION + AWS_REGION into spawn env", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform, state } = stubSpawn([
      successResult(),
      successResult(),
      successResult(JSON.stringify(VALID_OUTPUT_JSON)),
    ]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await handler(VALID_INPUT);

    const env = state.calls[0]!.env;
    expect(env["TF_CLI_CONFIG_FILE"]).toBe("/tmp/.terraformrc");
    expect(env["TF_IN_AUTOMATION"]).toBe("1");
    expect(env["TF_INPUT"]).toBe("0");
    expect(env["AWS_REGION"]).toBe("us-east-1");
    expect(env["AWS_DEFAULT_REGION"]).toBe("us-east-1");
  });
});

describe("run-terraform handler — workflow input parse failure", () => {
  it("throws IronforgeWorkflowInputError BEFORE any DDB write", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform } = stubSpawn([]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await expect(handler({ not: "valid" })).rejects.toMatchObject({
      name: "IronforgeWorkflowInputError",
    });

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("throws IronforgeWorkflowInputError when templateId is unknown", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform } = stubSpawn([]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    const unknownTemplate = { ...VALID_INPUT, templateId: "future-template" };
    await expect(handler(unknownTemplate)).rejects.toMatchObject({
      name: "IronforgeWorkflowInputError",
    });

    // Unknown templateId fails BEFORE the workflow runs — no DDB writes.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("run-terraform handler — terraform init failure", () => {
  it("throws IronforgeTerraformInitError; apply NOT called; JobStep failed", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform, state: spawnState } = stubSpawn([
      failureResult("Error: backend init failed"),
    ]);
    const { fsOps, state: fsState } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeTerraformInitError,
    );

    // Only init was called.
    expect(spawnState.calls).toHaveLength(1);

    // DDB Running + Failed.
    const ddbCalls = ddbMock.commandCalls(UpdateCommand);
    expect(ddbCalls).toHaveLength(2);
    expect(
      ddbCalls[1]!.args[0].input.ExpressionAttributeValues?.[":errorName"],
    ).toBe("IronforgeTerraformInitError");

    // Workdir cleaned up even on failure.
    expect(fsState.rmCalls).toEqual([`/test-tmp/${VALID_INPUT.jobId}`]);
  });

  it("does not leak terraform stderr into JobStep.errorMessage", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const leakyStderr =
      "Error: AccessDenied: User: arn:aws:sts::123456789012:assumed-role/SECRET_ROLE/...";
    const { spawnTerraform } = stubSpawn([failureResult(leakyStderr)]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await expect(handler(VALID_INPUT)).rejects.toThrow();

    const failed = ddbMock.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(JSON.stringify(failed.ExpressionAttributeValues)).not.toContain(
      "SECRET_ROLE",
    );
  });
});

describe("run-terraform handler — terraform apply failure", () => {
  it("throws IronforgeTerraformApplyError; output NOT called", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform, state } = stubSpawn([
      successResult(),
      failureResult("Error: BucketAlreadyExists"),
    ]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeTerraformApplyError,
    );

    expect(state.calls).toHaveLength(2); // init + apply, no output
  });
});

describe("run-terraform handler — terraform output failures", () => {
  it("throws IronforgeTerraformOutputError when terraform output -json exits non-zero", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform } = stubSpawn([
      successResult(),
      successResult(),
      failureResult("Error: state file not found"),
    ]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeTerraformOutputError,
    );
  });

  it("throws IronforgeTerraformOutputError when terraform output -json stdout is malformed JSON", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform } = stubSpawn([
      successResult(),
      successResult(),
      successResult("not-json-at-all"),
    ]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeTerraformOutputError,
    );
  });

  it("throws IronforgeTerraformOutputError when outputs schema validation fails", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const partialOutputs = {
      bucket_name: { value: "ironforge-svc-my-site-origin", type: "string", sensitive: false },
      // Missing distribution_id, distribution_domain_name, deploy_role_arn, live_url, fqdn.
    };
    const { spawnTerraform } = stubSpawn([
      successResult(),
      successResult(),
      successResult(JSON.stringify(partialOutputs)),
    ]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeTerraformOutputError,
    );
  });

  it("throws IronforgeTerraformOutputError when output payload has unexpected extra fields", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const surpriseOutput = {
      ...VALID_OUTPUT_JSON,
      surprise_field: { value: "x", type: "string", sensitive: false },
    };
    const { spawnTerraform } = stubSpawn([
      successResult(),
      successResult(),
      successResult(JSON.stringify(surpriseOutput)),
    ]);
    const { fsOps } = stubFsOps();
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    // .strict() on StaticSiteOutputsSchema rejects unexpected keys.
    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeTerraformOutputError,
    );
  });
});

describe("run-terraform handler — workdir cleanup", () => {
  it("cleanup error is logged but does not mask the original failure", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { spawnTerraform } = stubSpawn([
      failureResult("Error: init failed"),
    ]);
    const { fsOps } = stubFsOps(new Error("ENOENT: workdir gone"));
    const handler = buildHandler({
      config: TEST_CONFIG,
      spawnTerraform,
      fsOps,
      workDirRoot: "/test-tmp",
    });

    // Original error is the IronforgeTerraformInitError, not the rm error.
    await expect(handler(VALID_INPUT)).rejects.toBeInstanceOf(
      IronforgeTerraformInitError,
    );
  });
});
