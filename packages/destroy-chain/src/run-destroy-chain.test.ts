import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Uint8ArrayBlobAdapter } from "@smithy/util-stream";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReposDelete = vi.fn();
const mockGetInstallationToken = vi.fn();
const mockBuildOctokit = vi.fn();

vi.mock("@ironforge/shared-utils", () => ({
  getInstallationToken: mockGetInstallationToken,
  buildAuthenticatedOctokit: mockBuildOctokit,
}));

const { runDestroyChain } = await import("./run-destroy-chain.js");

const lambdaMock = mockClient(LambdaClient);
const s3Mock = mockClient(S3Client);

const BASE_INPUT = {
  runTerraformLambdaName: "ironforge-dev-run-terraform",
  event: {
    serviceId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
  },
  serviceId: "11111111-1111-4111-8111-111111111111",
  serviceName: "my-site",
  tfstateBucket: "ironforge-dev-tfstate",
  githubOrg: "ironforge-svc",
  githubAppAuth: {
    secretArn: "arn:aws:secretsmanager:us-east-1:000:secret:gh-app",
    appId: "12345",
    installationId: "67890",
  },
};

beforeEach(() => {
  lambdaMock.reset();
  s3Mock.reset();
  mockReposDelete.mockReset();
  mockGetInstallationToken.mockReset().mockResolvedValue({ token: "ghs_test" });
  mockBuildOctokit
    .mockReset()
    .mockReturnValue({ rest: { repos: { delete: mockReposDelete } } });
});

describe("runDestroyChain", () => {
  it("runs all three phases sequentially and returns each outcome", async () => {
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200 });
    mockReposDelete.mockResolvedValue({ status: 204 });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await runDestroyChain(BASE_INPUT);

    expect(result.terraform.status).toBe("succeeded");
    expect(result.githubRepo.status).toBe("succeeded");
    expect(result.tfstate.status).toBe("succeeded");
  });

  it("does not short-circuit on terraform failure — runs github + tfstate too", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: Uint8ArrayBlobAdapter.fromString("{}"),
    });
    mockReposDelete.mockResolvedValue({ status: 204 });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await runDestroyChain(BASE_INPUT);

    expect(result.terraform.status).toBe("failed");
    expect(result.githubRepo.status).toBe("succeeded");
    expect(result.tfstate.status).toBe("succeeded");
  });

  it("does not short-circuit on github failure — runs tfstate too", async () => {
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200 });
    mockReposDelete.mockRejectedValue(
      Object.assign(new Error("forbidden"), { status: 403 }),
    );
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await runDestroyChain(BASE_INPUT);

    expect(result.terraform.status).toBe("succeeded");
    expect(result.githubRepo.status).toBe("failed");
    expect(result.tfstate.status).toBe("succeeded");
  });

  it("returns failed for each independent phase failure", async () => {
    lambdaMock.on(InvokeCommand).rejects(new Error("invoke threw"));
    mockReposDelete.mockRejectedValue(new Error("github threw"));
    const s3Err = new Error("s3 access denied");
    s3Err.name = "AccessDenied";
    s3Mock.on(DeleteObjectCommand).rejects(s3Err);

    const result = await runDestroyChain(BASE_INPUT);

    expect(result.terraform.status).toBe("failed");
    expect(result.githubRepo.status).toBe("failed");
    expect(result.tfstate.status).toBe("failed");
  });

  it("invokes phases in order: terraform → github → tfstate", async () => {
    const callOrder: string[] = [];

    lambdaMock.on(InvokeCommand).callsFake(async () => {
      callOrder.push("terraform");
      return { StatusCode: 200 };
    });
    mockReposDelete.mockImplementation(async () => {
      callOrder.push("github");
      return { status: 204 };
    });
    s3Mock.on(DeleteObjectCommand).callsFake(async () => {
      callOrder.push("tfstate");
      return {};
    });

    await runDestroyChain(BASE_INPUT);

    expect(callOrder).toEqual(["terraform", "github", "tfstate"]);
  });
});
