// Custom error class for GitHub App auth failures. SFN's state-level
// Retry block matches by error name; "IronforgeGitHubAuthError" is
// excluded from Retry by design (auth failures are permanent — PEM is
// wrong, installation revoked, etc., none of which retrying helps).
// Catch routes the workflow to CleanupOnFailure. See ADR-008 § "Why
// per-invocation, not cached" for the revocation-detection rationale,
// and docs/state-machine.md § "Error-class taxonomy" for the SFN
// matching contract.
//
// The context object captures everything operators need for triage
// without leaking secrets. Per CLAUDE.md error sanitization: never
// include the PEM, JWT, response body, or any token (failed or
// successful) in error messages or context. Status code, endpoint,
// and identifiers are safe.

export type GitHubAuthMintType =
  // Secrets Manager fetch of the PEM failed (network, IAM, or empty
  // response). Pre-HTTP failure — no GitHub endpoint involved.
  | "secret-fetch"
  // Secrets Manager returned content that doesn't look like a PEM
  // (missing BEGIN/END markers, wrong length, etc.). Pre-HTTP failure.
  | "pem-parse"
  // @octokit/auth-app's installation-token exchange failed. The
  // GitHub endpoint was reached; status code captures GitHub's
  // response (401/403 = permanent, 5xx = transient but the helper
  // doesn't retry — see ADR-008 deferred caching options).
  | "token-exchange";

export type GitHubAuthErrorContext = {
  mintType: GitHubAuthMintType;
  // GitHub App ID. From the SSM parameter or env var, never derived
  // from a token.
  appId: string;
  // Installation ID. Same source.
  installationId: string;
  // GitHub API endpoint where the failure surfaced. Present only for
  // mintType: "token-exchange". Always a string literal — never
  // user-supplied input.
  endpoint?: string;
  // HTTP status from GitHub. Present only for mintType:
  // "token-exchange" failures with an HTTP layer.
  status?: number;
};

export class IronforgeGitHubAuthError extends Error {
  override readonly name = "IronforgeGitHubAuthError";

  constructor(
    message: string,
    public readonly context: GitHubAuthErrorContext,
  ) {
    super(message);
  }
}

// Errors thrown by GitHub-talking workflow Lambdas (create-repo,
// trigger-deploy). All custom-named so SFN's state-level Retry block
// (Lambda.* family only) doesn't loop on permanent failures —
// CleanupOnFailure handles them. JobStep.errorMessage is sanitized;
// CloudWatch structured log carries operator-visible detail.

export type GitHubOperationContext = {
  // GitHub API endpoint where the failure surfaced (e.g.,
  // "POST /orgs/ironforge-svc/repos"). String literal — never
  // user-supplied input.
  endpoint: string;
  appId: string;
  installationId: string;
  // GitHub HTTP status when the call reached GitHub. Absent for
  // pre-HTTP failures (rare; mostly captured by IronforgeGitHubAuthError).
  status?: number;
};

// Repo with the requested name already exists but its
// `custom_properties["ironforge-job-id"]` does not match THIS job.
// Means a prior provisioning under the same name left an orphan
// (cleanup-on-failure destroy chain not yet implemented — see
// docs/tech-debt.md), or a manual operator action created the repo.
// Resolution: operator deletes the orphan repo, retries provisioning.
//
// Context deliberately does NOT include the existing repo's job-id —
// that's an internal cross-tenant identifier and should not flow into
// this Lambda's error path. Operators correlate via CloudWatch log
// + the GitHub repo itself, not via JobStep.errorMessage.
export class IronforgeGitHubRepoConflictError extends Error {
  override readonly name = "IronforgeGitHubRepoConflictError";

  constructor(
    message: string,
    public readonly context: GitHubOperationContext & { repoName: string },
  ) {
    super(message);
  }
}

// GitHub returned 403 with X-RateLimit-Remaining: 0. Distinct from
// IronforgeGitHubAuthError ("Bad credentials") because it's recoverable
// (just transient — primary or secondary rate limit window will reset).
// Past-participle naming matches AWS SDK conventions (Throttled,
// RateLimited).
//
// X-RateLimit-Reset (Unix timestamp when the limit window resets) goes
// to CloudWatch via console.error — never into the error context, per
// the sanitization principle. Operator visibility, not user-facing.
export class IronforgeGitHubRateLimitedError extends Error {
  override readonly name = "IronforgeGitHubRateLimitedError";

  constructor(
    message: string,
    public readonly context: GitHubOperationContext,
  ) {
    super(message);
  }
}

// Catch-all for unexpected GitHub responses that don't fit the more
// specific error classes above. Operations that can throw this:
// repo creation, repo lookup, custom-property reads. The `operation`
// discriminator helps operators correlate with the specific call site.
export type GitHubProvisionOperation =
  | "get-repo"
  | "create-repo"
  | "unknown";

export class IronforgeGitHubProvisionError extends Error {
  override readonly name = "IronforgeGitHubProvisionError";

  constructor(
    message: string,
    public readonly context: GitHubOperationContext & {
      operation: GitHubProvisionOperation;
    },
  ) {
    super(message);
  }
}
