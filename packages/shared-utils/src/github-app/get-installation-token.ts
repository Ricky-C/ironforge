import { createAppAuth } from "@octokit/auth-app";
import {
  GetSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import { secretsManagerClient as defaultSecretsManagerClient } from "../aws/clients.js";
import { IronforgeGitHubAuthError } from "./errors.js";

// Module-scope lazy cache for the parsed PEM. The PEM doesn't expire,
// so caching across the warm-Lambda lifetime is correct. ADR-008
// distinguishes this (static credential material) from token caching
// (rejected); see docs/conventions.md § "Cold-start configuration
// loading" for the broader pattern.
//
// Map keyed by secretArn. In Phase 1 every consumer Lambda passes the
// same secretArn (its env-var-resolved github-app secret ARN), so the
// map has at most one entry per warm Lambda. The map shape (vs a
// single optional value) is defensive: a future Lambda passing two
// different ARNs would get correct caching rather than silently
// reusing the wrong PEM.
const pemCache = new Map<string, string>();

// SecretsManagerClient surface we actually use. Lets tests inject a
// minimal fake without satisfying the full client interface.
type SecretsManagerLike = Pick<SecretsManagerClient, "send">;

// @octokit/auth-app's auth function shape. Strongly typed here so the
// factory injection seam (authFactory below) is type-checkable instead
// of any/unknown.
type AuthFunction = (params: { type: "installation" }) => Promise<{
  token: string;
  expiresAt: string;
}>;

type AuthFactory = (config: {
  appId: string;
  privateKey: string;
  installationId: string;
}) => AuthFunction;

// Default factory wraps @octokit/auth-app. Cast is necessary because
// createAppAuth's overloaded return type is wider than what we use.
const defaultAuthFactory: AuthFactory = (config) =>
  createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: config.installationId,
  }) as unknown as AuthFunction;

export type GetInstallationTokenParams = {
  // Secrets Manager ARN holding the GitHub App PEM. Read once per
  // warm Lambda; cached at module scope.
  secretArn: string;
  // GitHub App ID — JWT iss claim. Sourced from SSM parameter or
  // env var by the caller; helper does not resolve it.
  appId: string;
  // GitHub App installation ID. Identifies which installation's
  // token to mint (one App may have multiple installations).
  installationId: string;
  // Test injection seam for the Secrets Manager client. Production
  // code passes nothing.
  secretsManagerClient?: SecretsManagerLike;
  // Test injection seam for @octokit/auth-app. Production code
  // passes nothing.
  authFactory?: AuthFactory;
};

export type InstallationToken = {
  // GitHub installation access token. 1-hour TTL, used as bearer for
  // subsequent GitHub API calls. Per ADR-008 this token is per-
  // invocation — callers should not cache it across invocations.
  token: string;
  // GitHub-reported expiry. Useful for observability and for callers
  // that want to verify the token has remaining lifetime before a
  // long-running operation.
  expiresAt: Date;
};

const fetchAndCachePem = async (
  secretArn: string,
  client: SecretsManagerLike,
  appId: string,
  installationId: string,
): Promise<string> => {
  const cached = pemCache.get(secretArn);
  if (cached !== undefined) {
    return cached;
  }

  let secretString: string | undefined;
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    secretString = result.SecretString;
  } catch {
    throw new IronforgeGitHubAuthError(
      "Secrets Manager fetch failed for GitHub App PEM",
      { mintType: "secret-fetch", appId, installationId },
    );
  }

  if (typeof secretString !== "string" || secretString.length === 0) {
    throw new IronforgeGitHubAuthError(
      "GitHub App PEM secret is empty or missing",
      { mintType: "secret-fetch", appId, installationId },
    );
  }

  // Surface PEM-shape failure as a parse error rather than letting
  // @octokit/auth-app throw a less-actionable error mid-mint. The
  // shape check is conservative — both BEGIN PRIVATE KEY (PKCS#8)
  // and BEGIN RSA PRIVATE KEY (PKCS#1) are valid, so we only require
  // the BEGIN/END framing markers, not a specific algorithm.
  if (!secretString.includes("-----BEGIN") || !secretString.includes("PRIVATE KEY-----")) {
    throw new IronforgeGitHubAuthError(
      "GitHub App secret does not appear to be a PEM-encoded private key",
      { mintType: "pem-parse", appId, installationId },
    );
  }

  pemCache.set(secretArn, secretString);
  return secretString;
};

// Mints a GitHub installation access token. Per ADR-008 the token is
// fresh per invocation; callers should not cache the returned token
// across invocations. The PEM is cached at module scope (lazy on
// first call) — that's a separate caching decision (static credential
// vs ephemeral token).
//
// On any failure throws IronforgeGitHubAuthError with sanitized context.
// SFN's state-level Retry block excludes the custom error name by
// design; permanent auth failures fall through to CleanupOnFailure.
export const getInstallationToken = async (
  params: GetInstallationTokenParams,
): Promise<InstallationToken> => {
  const { secretArn, appId, installationId } = params;
  const secretsManagerClient =
    params.secretsManagerClient ?? defaultSecretsManagerClient;
  const authFactory = params.authFactory ?? defaultAuthFactory;

  const privateKey = await fetchAndCachePem(
    secretArn,
    secretsManagerClient,
    appId,
    installationId,
  );

  const auth = authFactory({ appId, privateKey, installationId });

  let result: { token: string; expiresAt: string };
  try {
    result = await auth({ type: "installation" });
  } catch (err) {
    // @octokit/auth-app throws RequestError on HTTP failures; the
    // status property is the GitHub HTTP status. Capture it without
    // surfacing the underlying error's message (the message can
    // contain context we don't want in our sanitized error).
    const status = (err as { status?: number })?.status;
    throw new IronforgeGitHubAuthError(
      "GitHub installation-token exchange failed",
      {
        mintType: "token-exchange",
        appId,
        installationId,
        endpoint: `POST /app/installations/${installationId}/access_tokens`,
        ...(typeof status === "number" ? { status } : {}),
      },
    );
  }

  return {
    token: result.token,
    expiresAt: new Date(result.expiresAt),
  };
};

// Test-only export. Production code MUST NOT call this; the cache is
// designed to live the warm-Lambda lifetime. Exported so tests can
// reset across cases without re-importing the module.
export const __resetPemCacheForTests = (): void => {
  pemCache.clear();
};
