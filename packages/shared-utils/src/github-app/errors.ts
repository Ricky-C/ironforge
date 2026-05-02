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
