import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";

// Builds an Octokit instance authenticated with a GitHub installation
// access token (minted via getInstallationToken), with the retry plugin
// configured per the PR-C.4a defaults. Consumers (create-repo, trigger-
// deploy) call this rather than wiring Octokit themselves so the retry
// config stays consistent across consumers.
//
// Retry config rationale (locked in PR-C.4a's design conversation,
// adjusted in PR-C.4b after empirically discovering @octokit/plugin-
// retry's API quirk):
//
//   - retries: 2 → 3 attempts total. Configured via the constructor's
//     `retry: {}` option (NOT `request: {}`) — `request: { retries }`
//     is per-request and silently bypasses the plugin's `doNotRetry`
//     status-code list. The constructor `retry: { retries }` option
//     plays correctly with `doNotRetry`.
//   - 5xx (excluding 501) + 408 + 429 retried.
//   - 400 / 401 / 403 / 404 / 410 / 422 / 451 NOT retried — plugin's
//     `doNotRetry` default. Auth/permission/not-found errors are
//     permanent and re-attempting wastes time + obscures root cause.
//   - Backoff: plugin computes `Math.pow(retryCount+1, 2)` seconds
//     (1s, 4s, 9s, ...) — fits within Lambda timeout (60-120s) and
//     respects GitHub's Retry-After header when present. Not exposed
//     as a parameter because per-request override doesn't compose
//     with the plugin's internal computation; consumers wanting custom
//     backoff would need a different abstraction.
//
// Each consumer is free to override `retries` if its failure profile
// differs (currently no consumer does).

// Type annotation explicitly anchored to Octokit (not the inferred
// plugin-extended type) to avoid leaking deeply-nested @octokit/*
// types into our public API surface. The retry plugin attaches request
// hooks rather than new methods, so consumers interact with the
// standard Octokit interface either way.
export type AuthenticatedOctokit = Octokit;

const OctokitWithRetry: typeof Octokit = Octokit.plugin(retry);

export type BuildAuthenticatedOctokitParams = {
  // GitHub installation access token. From getInstallationToken — must
  // be fresh per ADR-008 (no caching). Caller is responsible for not
  // sharing tokens across invocations.
  token: string;
  // Number of retries on transient failures (5xx, 408, 429). Defaults
  // to 2 → 3 attempts total. Set lower for endpoints where retry would
  // double-create resources (none currently — repo creation is gated
  // by check-then-create idempotency at the helper level).
  retries?: number;
  // Test seam: override the plugin's retryAfterBaseValue (the
  // multiplier on the squared-backoff seconds-count). Production code
  // does NOT set this — defaults to 1000ms. Tests set it to 1 so the
  // exponential-backoff loop completes in milliseconds rather than
  // seconds.
  retryAfterBaseValueMs?: number;
};

export const buildAuthenticatedOctokit = (
  params: BuildAuthenticatedOctokitParams,
): AuthenticatedOctokit => {
  return new OctokitWithRetry({
    auth: params.token,
    retry: {
      retries: params.retries ?? 2,
      ...(params.retryAfterBaseValueMs !== undefined
        ? { retryAfterBaseValue: params.retryAfterBaseValueMs }
        : {}),
    },
  });
};
