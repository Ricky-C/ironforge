import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAuthenticatedOctokit } from "./build-authenticated-octokit.js";

beforeEach(() => {
  nock.cleanAll();
  if (!nock.isActive()) {
    nock.activate();
  }
});

afterEach(() => {
  nock.cleanAll();
});

describe("buildAuthenticatedOctokit — auth header", () => {
  it("sends the installation token as a bearer in the Authorization header", async () => {
    const scope = nock("https://api.github.com", {
      reqheaders: {
        authorization: (val) =>
          typeof val === "string" && val.toLowerCase().startsWith("token "),
      },
    })
      .get("/repos/ironforge-svc/test-repo")
      .reply(200, { id: 1, full_name: "ironforge-svc/test-repo" });

    const octokit = buildAuthenticatedOctokit({ token: "ghs_test_token" });
    const result = await octokit.rest.repos.get({
      owner: "ironforge-svc",
      repo: "test-repo",
    });

    expect(result.data.id).toBe(1);
    expect(scope.isDone()).toBe(true);
  });
});

describe("buildAuthenticatedOctokit — retry behavior", () => {
  it("retries 5xx responses and succeeds on the second attempt", async () => {
    const scope = nock("https://api.github.com")
      .get("/repos/ironforge-svc/test-repo")
      .reply(503, { message: "Service Unavailable" })
      .get("/repos/ironforge-svc/test-repo")
      .reply(200, { id: 2, full_name: "ironforge-svc/test-repo" });

    const octokit = buildAuthenticatedOctokit({
      token: "ghs_test_token",
      retryAfterBaseValueMs: 1,
    });
    const result = await octokit.rest.repos.get({
      owner: "ironforge-svc",
      repo: "test-repo",
    });

    expect(result.data.id).toBe(2);
    expect(scope.isDone()).toBe(true);
  });

  it("does not retry 401 (auth errors are permanent)", async () => {
    const scope = nock("https://api.github.com")
      .get("/repos/ironforge-svc/test-repo")
      .reply(401, { message: "Bad credentials" });

    const octokit = buildAuthenticatedOctokit({
      token: "ghs_invalid_token",
      retryAfterBaseValueMs: 1,
    });

    await expect(
      octokit.rest.repos.get({
        owner: "ironforge-svc",
        repo: "test-repo",
      }),
    ).rejects.toMatchObject({ status: 401 });

    expect(scope.isDone()).toBe(true);
    // Ensure no extra request was attempted; nock would still have
    // pending expectations if a retry had fired.
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it("does not retry 404 (not-found is permanent)", async () => {
    const scope = nock("https://api.github.com")
      .get("/repos/ironforge-svc/missing-repo")
      .reply(404, { message: "Not Found" });

    const octokit = buildAuthenticatedOctokit({
      token: "ghs_test_token",
      retryAfterBaseValueMs: 1,
    });

    await expect(
      octokit.rest.repos.get({
        owner: "ironforge-svc",
        repo: "missing-repo",
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(scope.isDone()).toBe(true);
  });

  it("gives up after exhausting the retry budget on persistent 5xx", async () => {
    const scope = nock("https://api.github.com")
      .get("/repos/ironforge-svc/flaky-repo")
      .times(3) // initial + 2 retries (PR-C.4a default: retries=2)
      .reply(503, { message: "Service Unavailable" });

    const octokit = buildAuthenticatedOctokit({
      token: "ghs_test_token",
      retryAfterBaseValueMs: 1,
    });

    await expect(
      octokit.rest.repos.get({
        owner: "ironforge-svc",
        repo: "flaky-repo",
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(scope.isDone()).toBe(true);
  });

  it("respects an explicit retries override", async () => {
    const scope = nock("https://api.github.com")
      .get("/repos/ironforge-svc/once-flaky")
      .reply(503, { message: "Service Unavailable" })
      .get("/repos/ironforge-svc/once-flaky")
      .reply(503, { message: "Service Unavailable" });

    const octokit = buildAuthenticatedOctokit({
      token: "ghs_test_token",
      retryAfterBaseValueMs: 1,
      retries: 1, // 1 retry → 2 attempts total
    });

    await expect(
      octokit.rest.repos.get({
        owner: "ironforge-svc",
        repo: "once-flaky",
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(scope.isDone()).toBe(true);
  });
});
