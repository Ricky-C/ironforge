import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetPemCacheForTests,
  getInstallationToken,
} from "./get-installation-token.js";
import { IronforgeGitHubAuthError } from "./errors.js";

// Plausible-but-fake PEM. Shape-conformant (BEGIN/END markers) so the
// helper's parse-shape check passes; never used to mint real JWTs
// because the auth function is factory-injected in unit tests.
const FAKE_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF7r5SjXXsB7l4hOUm0d7jKMeKiVU",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:ironforge/github-app/private-key-AbCdEf";
const APP_ID = "3560881";
const INSTALLATION_ID = "128511853";

const sm = mockClient(SecretsManagerClient);

const stubAuthFactory = (
  result: { token: string; expiresAt: string } | Error,
) => {
  return () => async () => {
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
};

beforeEach(() => {
  sm.reset();
  __resetPemCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getInstallationToken — happy path", () => {
  it("fetches the PEM, mints a token, returns { token, expiresAt: Date }", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: FAKE_PEM });

    const result = await getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory({
        token: "ghs_fake_installation_token",
        expiresAt: "2026-05-02T01:00:00Z",
      }),
    });

    expect(result.token).toBe("ghs_fake_installation_token");
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.toISOString()).toBe("2026-05-02T01:00:00.000Z");
  });

  it("calls Secrets Manager with the supplied secretArn", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: FAKE_PEM });

    await getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory({
        token: "x",
        expiresAt: "2026-05-02T01:00:00Z",
      }),
    });

    const calls = sm.commandCalls(GetSecretValueCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.SecretId).toBe(SECRET_ARN);
  });
});

describe("getInstallationToken — module-scope PEM cache", () => {
  it("fetches Secrets Manager once across multiple calls with the same secretArn", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: FAKE_PEM });
    const auth = stubAuthFactory({
      token: "x",
      expiresAt: "2026-05-02T01:00:00Z",
    });

    await getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: auth,
    });
    await getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: auth,
    });
    await getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: auth,
    });

    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it("re-fetches when called with a different secretArn (cache is keyed by ARN)", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: FAKE_PEM });
    const auth = stubAuthFactory({
      token: "x",
      expiresAt: "2026-05-02T01:00:00Z",
    });

    await getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: auth,
    });
    await getInstallationToken({
      secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:ironforge/other",
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: auth,
    });

    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(2);
  });
});

describe("getInstallationToken — Secrets Manager failures", () => {
  it("throws IronforgeGitHubAuthError with mintType=secret-fetch on SDK error", async () => {
    sm.on(GetSecretValueCommand).rejects(new Error("simulated network error"));

    const promise = getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory({ token: "x", expiresAt: "2026-05-02T01:00:00Z" }),
    });

    await expect(promise).rejects.toBeInstanceOf(IronforgeGitHubAuthError);
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(IronforgeGitHubAuthError);
      const e = err as IronforgeGitHubAuthError;
      expect(e.context.mintType).toBe("secret-fetch");
      expect(e.context.appId).toBe(APP_ID);
      expect(e.context.installationId).toBe(INSTALLATION_ID);
    }
  });

  it("throws IronforgeGitHubAuthError with mintType=secret-fetch on empty SecretString", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: "" });

    const promise = getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory({ token: "x", expiresAt: "2026-05-02T01:00:00Z" }),
    });

    await expect(promise).rejects.toBeInstanceOf(IronforgeGitHubAuthError);
    try {
      await promise;
    } catch (err) {
      expect((err as IronforgeGitHubAuthError).context.mintType).toBe("secret-fetch");
    }
  });

  it("throws IronforgeGitHubAuthError with mintType=secret-fetch on missing SecretString", async () => {
    sm.on(GetSecretValueCommand).resolves({});

    const promise = getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory({ token: "x", expiresAt: "2026-05-02T01:00:00Z" }),
    });

    try {
      await promise;
      expect.fail("expected throw");
    } catch (err) {
      expect((err as IronforgeGitHubAuthError).context.mintType).toBe("secret-fetch");
    }
  });
});

describe("getInstallationToken — PEM shape failure", () => {
  it("throws IronforgeGitHubAuthError with mintType=pem-parse when content lacks BEGIN/END markers", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: "not a pem" });

    const promise = getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory({ token: "x", expiresAt: "2026-05-02T01:00:00Z" }),
    });

    await expect(promise).rejects.toBeInstanceOf(IronforgeGitHubAuthError);
    try {
      await promise;
    } catch (err) {
      const e = err as IronforgeGitHubAuthError;
      expect(e.context.mintType).toBe("pem-parse");
      expect(e.context.appId).toBe(APP_ID);
      expect(e.context.installationId).toBe(INSTALLATION_ID);
    }
  });

  it("does not cache an unparseable PEM (subsequent call retries the fetch)", async () => {
    sm.on(GetSecretValueCommand)
      .resolvesOnce({ SecretString: "not a pem" })
      .resolves({ SecretString: FAKE_PEM });

    await expect(
      getInstallationToken({
        secretArn: SECRET_ARN,
        appId: APP_ID,
        installationId: INSTALLATION_ID,
        authFactory: stubAuthFactory({ token: "x", expiresAt: "2026-05-02T01:00:00Z" }),
      }),
    ).rejects.toBeInstanceOf(IronforgeGitHubAuthError);

    const result = await getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory({ token: "second-call", expiresAt: "2026-05-02T01:00:00Z" }),
    });
    expect(result.token).toBe("second-call");

    // Two GetSecretValue calls — proves the failed parse didn't poison the cache.
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(2);
  });
});

describe("getInstallationToken — token exchange failures", () => {
  it("throws IronforgeGitHubAuthError with mintType=token-exchange on HTTP error", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: FAKE_PEM });

    // Simulate the shape @octokit/auth-app throws on HTTP failure.
    const httpErr = Object.assign(new Error("Unauthorized"), { status: 401 });

    const promise = getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory(httpErr),
    });

    await expect(promise).rejects.toBeInstanceOf(IronforgeGitHubAuthError);
    try {
      await promise;
    } catch (err) {
      const e = err as IronforgeGitHubAuthError;
      expect(e.context.mintType).toBe("token-exchange");
      expect(e.context.status).toBe(401);
      expect(e.context.endpoint).toBe(
        `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
      );
    }
  });

  it("propagates 5xx as token-exchange (no internal retry; consumers handle their own Octokit retry)", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: FAKE_PEM });
    const httpErr = Object.assign(new Error("Service Unavailable"), { status: 503 });

    const promise = getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory(httpErr),
    });

    try {
      await promise;
      expect.fail("expected throw");
    } catch (err) {
      expect((err as IronforgeGitHubAuthError).context.status).toBe(503);
    }
  });

  it("works when underlying error has no status property", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: FAKE_PEM });
    const opaqueErr = new Error("cryptic library failure");

    const promise = getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory(opaqueErr),
    });

    try {
      await promise;
      expect.fail("expected throw");
    } catch (err) {
      const e = err as IronforgeGitHubAuthError;
      expect(e.context.mintType).toBe("token-exchange");
      expect(e.context.status).toBeUndefined();
    }
  });
});

describe("getInstallationToken — error message sanitization", () => {
  it("does not leak the PEM, JWT, or underlying error message into the thrown error", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: FAKE_PEM });

    const sensitiveErr = Object.assign(
      new Error(
        "underlying detail with sensitive content like MIIEowIBAAKCAQEA and ghs_realtoken",
      ),
      { status: 401 },
    );

    const promise = getInstallationToken({
      secretArn: SECRET_ARN,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      authFactory: stubAuthFactory(sensitiveErr),
    });

    try {
      await promise;
      expect.fail("expected throw");
    } catch (err) {
      const e = err as IronforgeGitHubAuthError;
      expect(e.message).not.toContain("MIIEowIBAAKCAQEA");
      expect(e.message).not.toContain("ghs_realtoken");
      expect(JSON.stringify(e.context)).not.toContain("MIIEowIBAAKCAQEA");
      expect(JSON.stringify(e.context)).not.toContain("ghs_realtoken");
    }
  });
});
