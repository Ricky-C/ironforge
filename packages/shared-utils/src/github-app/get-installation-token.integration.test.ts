import { generateKeyPairSync } from "node:crypto";

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import nock from "nock";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  __resetPemCacheForTests,
  getInstallationToken,
} from "./get-installation-token.js";
import { IronforgeGitHubAuthError } from "./errors.js";

// Integration tests exercising the real @octokit/auth-app code path
// against nock-mocked GitHub responses. Factory-injection unit tests
// (sibling .test.ts file) cover helper logic; these tests verify the
// HTTP-layer wiring the unit tests can't see — endpoint URL, request
// shape, response parsing, and error-status mapping.
//
// A throwaway RSA keypair is generated per test suite so the JWT mint
// path runs end-to-end without committing a real PEM.

const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:ironforge/github-app/private-key-AbCdEf";
const APP_ID = "3560881";
const INSTALLATION_ID = "128511853";

let testPem: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  testPem = privateKey;
});

const sm = mockClient(SecretsManagerClient);

beforeEach(() => {
  sm.reset();
  __resetPemCacheForTests();
  nock.cleanAll();
  if (!nock.isActive()) {
    nock.activate();
  }
});

afterEach(() => {
  nock.cleanAll();
});

describe("getInstallationToken — integration with @octokit/auth-app + GitHub HTTP", () => {
  it("calls POST /app/installations/{id}/access_tokens with a JWT bearer and parses the response", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: testPem });

    const expiresAt = "2026-05-02T01:00:00Z";
    const scope = nock("https://api.github.com")
      .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
      .matchHeader("authorization", (val) =>
        typeof val === "string" && val.startsWith("bearer "),
      )
      .reply(201, {
        token: "ghs_integration_test_token",
        expires_at: expiresAt,
      });

    const result = await getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
    });

    expect(result.token).toBe("ghs_integration_test_token");
    expect(result.expiresAt.toISOString()).toBe("2026-05-02T01:00:00.000Z");
    expect(scope.isDone()).toBe(true);
  });

  it("surfaces a 401 from GitHub as IronforgeGitHubAuthError with status:401", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: testPem });

    nock("https://api.github.com")
      .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
      .reply(401, {
        message: "Bad credentials",
        documentation_url: "https://docs.github.com/rest",
      });

    try {
      await getInstallationToken({
        secretArn: SECRET_ARN,
        appId: APP_ID,
        installationId: INSTALLATION_ID,
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IronforgeGitHubAuthError);
      const e = err as IronforgeGitHubAuthError;
      expect(e.context.mintType).toBe("token-exchange");
      expect(e.context.status).toBe(401);
      expect(e.context.endpoint).toBe(
        `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
      );
      // Sanitization: the GitHub response body's "Bad credentials"
      // message must not appear in our error message or context.
      expect(e.message).not.toContain("Bad credentials");
      expect(JSON.stringify(e.context)).not.toContain("Bad credentials");
    }
  });
});
