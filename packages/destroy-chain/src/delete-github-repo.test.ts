import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock the shared-utils package to stub Octokit construction. We
// inject a fake octokit whose rest.repos.delete is a vi.fn we can drive
// per-test. This is hoisted before the import below.
const mockReposDelete = vi.fn();
const mockGetInstallationToken = vi.fn();
const mockBuildOctokit = vi.fn();

vi.mock("@ironforge/shared-utils", () => ({
  getInstallationToken: mockGetInstallationToken,
  buildAuthenticatedOctokit: mockBuildOctokit,
}));

const { deleteGithubRepo } = await import("./delete-github-repo.js");

const VALID_INPUT = {
  owner: "ironforge-svc",
  repo: "my-site",
  appAuth: {
    secretArn: "arn:aws:secretsmanager:us-east-1:000:secret:gh-app",
    appId: "12345",
    installationId: "67890",
  },
};

beforeEach(() => {
  mockReposDelete.mockReset();
  mockGetInstallationToken.mockReset();
  mockBuildOctokit.mockReset();

  mockGetInstallationToken.mockResolvedValue({ token: "ghs_test" });
  mockBuildOctokit.mockReturnValue({
    rest: { repos: { delete: mockReposDelete } },
  });
});

describe("deleteGithubRepo", () => {
  it("returns succeeded (deleted) on a normal delete", async () => {
    mockReposDelete.mockResolvedValue({ status: 204 });

    const outcome = await deleteGithubRepo(VALID_INPUT);

    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.detail).toBe("deleted");
    }
  });

  it("calls Octokit with owner + repo from input", async () => {
    mockReposDelete.mockResolvedValue({ status: 204 });

    await deleteGithubRepo(VALID_INPUT);

    expect(mockReposDelete).toHaveBeenCalledWith({
      owner: VALID_INPUT.owner,
      repo: VALID_INPUT.repo,
    });
  });

  it("forwards appAuth params to getInstallationToken", async () => {
    mockReposDelete.mockResolvedValue({ status: 204 });

    await deleteGithubRepo(VALID_INPUT);

    expect(mockGetInstallationToken).toHaveBeenCalledWith({
      secretArn: VALID_INPUT.appAuth.secretArn,
      appId: VALID_INPUT.appAuth.appId,
      installationId: VALID_INPUT.appAuth.installationId,
    });
  });

  it("treats 404 as succeeded (already-absent)", async () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    mockReposDelete.mockRejectedValue(err);

    const outcome = await deleteGithubRepo(VALID_INPUT);

    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.detail).toBe("already-absent");
    }
  });

  it("returns failed with httpStatus on 403", async () => {
    const err = Object.assign(new Error("Resource not accessible"), { status: 403 });
    mockReposDelete.mockRejectedValue(err);

    const outcome = await deleteGithubRepo(VALID_INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.httpStatus).toBe(403);
      expect(outcome.error).toBe("Resource not accessible");
    }
  });

  it("returns failed with undefined httpStatus on a non-HTTP error", async () => {
    mockReposDelete.mockRejectedValue(new Error("network unreachable"));

    const outcome = await deleteGithubRepo(VALID_INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.httpStatus).toBeUndefined();
      expect(outcome.error).toBe("network unreachable");
    }
  });

  it("propagates token-mint failures as 'failed' (token mint is part of the operation)", async () => {
    mockGetInstallationToken.mockRejectedValue(new Error("Secrets Manager 403"));

    const outcome = await deleteGithubRepo(VALID_INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Secrets Manager 403");
    }
    expect(mockReposDelete).not.toHaveBeenCalled();
  });
});
