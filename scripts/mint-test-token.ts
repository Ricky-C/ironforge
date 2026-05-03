// mint-test-token.ts — mint a Cognito access token via SRP for a synthetic
// test user. Used by dev verification flows (first POST /api/services
// kickoff, drift-detector verification, future demo walkthroughs) to obtain
// a Bearer access token without enabling USER_PASSWORD_AUTH or
// ADMIN_USER_PASSWORD_AUTH on the Cognito client. The dev client is
// SRP-only by design (see infra/modules/cognito/main.tf) so this helper
// performs the SRP dance via amazon-cognito-identity-js.
//
// Companion to docs/runbook.md § "Synthetic test user for dev verification".
//
// Required env vars:
//   COGNITO_USER_POOL_ID   e.g. us-east-1_xxx
//   COGNITO_CLIENT_ID      app client ID for the target env
//   COGNITO_USERNAME       synthetic test user (e.g. e2e-verify-001@ironforge.test)
//   COGNITO_PASSWORD       permanent password set via admin-set-user-password
//
// stdout: the access token, single line. Compose via
//   TOKEN=$(pnpm mint-test-token)
// stderr: progress messages, expiration timestamp, errors.
//
// Exit codes: 0 success, 1 auth failure, 2 missing/invalid env.

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`error: required env var ${name} is not set\n`);
    process.exit(2);
  }
  return value;
};

const poolId = requireEnv("COGNITO_USER_POOL_ID");
const clientId = requireEnv("COGNITO_CLIENT_ID");
const username = requireEnv("COGNITO_USERNAME");
const password = requireEnv("COGNITO_PASSWORD");

const userPool = new CognitoUserPool({ UserPoolId: poolId, ClientId: clientId });
const cognitoUser = new CognitoUser({ Username: username, Pool: userPool });
const authDetails = new AuthenticationDetails({ Username: username, Password: password });

process.stderr.write(`authenticating ${username} via SRP against ${poolId}...\n`);

cognitoUser.authenticateUser(authDetails, {
  onSuccess: (session) => {
    const accessToken = session.getAccessToken();
    const expiresAt = new Date(accessToken.getExpiration() * 1000);
    const minutesLeft = Math.round((expiresAt.getTime() - Date.now()) / 60_000);
    process.stderr.write(
      `access token minted; expires ${expiresAt.toISOString()} (~${minutesLeft} min)\n`,
    );
    process.stdout.write(`${accessToken.getJwtToken()}\n`);
    process.exit(0);
  },
  onFailure: (err: Error) => {
    const code = err.name;
    if (code === "UserNotFoundException") {
      process.stderr.write(
        `error: user '${username}' does not exist in pool ${poolId}\n` +
          `  fix: create via aws cognito-idp admin-create-user (see docs/runbook.md § synthetic test user)\n`,
      );
    } else if (code === "NotAuthorizedException") {
      process.stderr.write(
        `error: NotAuthorizedException: ${err.message}\n` +
          `  cause: wrong password, OR user is in a non-CONFIRMED state, OR client not enabled for USER_SRP_AUTH\n`,
      );
    } else if (code === "PasswordResetRequiredException") {
      process.stderr.write(
        `error: user requires password reset before authenticating\n` +
          `  fix: aws cognito-idp admin-set-user-password --user-pool-id ${poolId} --username ${username} --password '<new>' --permanent\n`,
      );
    } else if (code === "UserNotConfirmedException") {
      process.stderr.write(
        `error: user is not confirmed\n` +
          `  fix: aws cognito-idp admin-confirm-sign-up --user-pool-id ${poolId} --username ${username}\n`,
      );
    } else {
      process.stderr.write(`error: ${code}: ${err.message}\n`);
    }
    process.exit(1);
  },
  // FORCE_CHANGE_PASSWORD challenge — happens when admin-create-user was run
  // without a follow-up admin-set-user-password --permanent. SRP succeeded
  // but the user is in a transitional state; surfacing the exact remediation
  // saves a debugging round-trip.
  newPasswordRequired: () => {
    process.stderr.write(
      `error: user is in FORCE_CHANGE_PASSWORD state\n` +
        `  cause: admin-create-user without follow-up admin-set-user-password --permanent\n` +
        `  fix: aws cognito-idp admin-set-user-password --user-pool-id ${poolId} --username ${username} --password '<new>' --permanent\n`,
    );
    process.exit(1);
  },
  mfaRequired: () => {
    process.stderr.write(`error: pool requires SMS MFA — not supported by this script\n`);
    process.exit(1);
  },
  totpRequired: () => {
    process.stderr.write(`error: pool requires TOTP MFA — not supported by this script\n`);
    process.exit(1);
  },
});
