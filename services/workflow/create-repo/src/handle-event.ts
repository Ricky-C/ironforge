import {
  WorkflowExecutionInputSchema,
  type StepName,
} from "@ironforge/shared-types";
import {
  buildAuthenticatedOctokit,
  getInstallationToken,
  getTableName,
  IronforgeGitHubAuthError,
  IronforgeGitHubProvisionError,
  IronforgeGitHubRateLimitedError,
  IronforgeGitHubRepoConflictError,
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
  type AuthenticatedOctokit,
  type InstallationToken,
} from "@ironforge/shared-utils";

// Real create-repo Lambda body. Replaces the PR-C.2 stub.
//
// Pipeline:
//   1. Parse SFN input as WorkflowExecutionInput.
//   2. upsertJobStepRunning("create-repo"). Natural-key idempotent.
//   3. Mint a fresh installation token (per ADR-008: per-invocation,
//      no cache).
//   4. GET /repos/{org}/{name} for existing-repo idempotency check
//      via custom_properties["ironforge-job-id"]:
//        - 404 → does not exist; create.
//        - 200 + matching jobId → idempotent retry; build output
//          from existing repo data, succeed.
//        - 200 + non-matching jobId → IronforgeGitHubRepoConflictError.
//        - other → IronforgeGitHubProvisionError.
//   5. POST /orgs/{org}/repos with name + description + private + the
//      jobId in custom_properties (atomic create-with-marker).
//   6. upsertJobStepSucceeded with full output shape.
//
// Output captured on JobStep + flowed to downstream states via SFN
// $.steps.create-repo:
//   - repoFullName (consumed by generate-code, trigger-deploy)
//   - repoUrl (operator visibility, finalize Service.repoUrl in Phase 2)
//   - defaultBranch (consumed by trigger-deploy)
//   - repoId (numeric, stable across renames — see PR-C.4b design conv)
//   - createdAt (operator visibility, useful for forensics)

const STEP_NAME: StepName = "create-repo";

// Static config resolved per-Lambda from env vars. Per docs/conventions.md
// § "Cold-start configuration loading" — lazy on first call, fail fast on
// any missing value. Tests inject deps via the buildHandler factory and
// don't trip this path.
type LambdaConfig = {
  secretArn: string;
  appId: string;
  installationId: string;
  orgName: string;
};

let configCache: LambdaConfig | undefined;
const getConfig = (): LambdaConfig => {
  if (configCache !== undefined) return configCache;

  const secretArn = process.env["GITHUB_APP_SECRET_ARN"];
  const appId = process.env["GITHUB_APP_ID"];
  const installationId = process.env["GITHUB_APP_INSTALLATION_ID"];
  const orgName = process.env["GITHUB_ORG_NAME"];

  const missing: string[] = [];
  if (!secretArn) missing.push("GITHUB_APP_SECRET_ARN");
  if (!appId) missing.push("GITHUB_APP_ID");
  if (!installationId) missing.push("GITHUB_APP_INSTALLATION_ID");
  if (!orgName) missing.push("GITHUB_ORG_NAME");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for create-repo Lambda: ${missing.join(", ")}`,
    );
  }

  configCache = {
    secretArn: secretArn!,
    appId: appId!,
    installationId: installationId!,
    orgName: orgName!,
  };
  return configCache;
};

// Test-only — production never resets config. Exported for test isolation.
export const __resetConfigCacheForTests = (): void => {
  configCache = undefined;
};

const CUSTOM_PROPERTY_KEY = "ironforge-job-id" as const;

const SANITIZED_INPUT_PARSE_MESSAGE =
  "Workflow execution input failed schema validation — see CloudWatch for the offending field";
const SANITIZED_REPO_CONFLICT_MESSAGE =
  "Repo with the requested name exists but was not created by this provisioning — operator cleanup required";
const SANITIZED_RATE_LIMITED_MESSAGE =
  "GitHub rate-limit hit — see CloudWatch for X-RateLimit-Reset value";
const SANITIZED_PROVISION_MESSAGE =
  "GitHub repo provisioning failed — see CloudWatch for endpoint + status";

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

export type CreateRepoOutput = {
  repoFullName: string;
  repoUrl: string;
  defaultBranch: string;
  repoId: number;
  createdAt: string;
};

// Octokit response shapes are narrowed on the read side: we only touch
// the fields the output needs + custom_properties + headers. Keeping
// these as Record<string, unknown> at the boundary lets us avoid
// importing the deeply-nested @octokit response types into our
// public-ish handler signatures.
type GitHubRepoResponse = {
  id: number;
  full_name: string;
  html_url: string;
  default_branch: string;
  created_at: string;
  custom_properties?: Record<string, string | null> | null;
};

const buildOutputFromRepo = (repo: GitHubRepoResponse): CreateRepoOutput => ({
  repoFullName: repo.full_name,
  repoUrl: repo.html_url,
  defaultBranch: repo.default_branch,
  repoId: repo.id,
  createdAt: repo.created_at,
});

// Discriminated union for the existence check's three states. Lets the
// caller switch on .kind cleanly and TS narrow the data shape.
type ExistenceResult =
  | { kind: "not-found" }
  | { kind: "ours"; repo: GitHubRepoResponse }
  | { kind: "conflict"; repo: GitHubRepoResponse };

const checkExistingRepo = async (
  octokit: AuthenticatedOctokit,
  org: string,
  name: string,
  jobId: string,
  appId: string,
  installationId: string,
): Promise<ExistenceResult> => {
  try {
    const response = await octokit.rest.repos.get({ owner: org, repo: name });
    const repo = response.data as unknown as GitHubRepoResponse;
    const ourTag = repo.custom_properties?.[CUSTOM_PROPERTY_KEY];
    if (ourTag === jobId) {
      return { kind: "ours", repo };
    }
    return { kind: "conflict", repo };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) {
      return { kind: "not-found" };
    }
    if (status === 401 || status === 403) {
      throw mapHttpError(err, "get-repo", `GET /repos/${org}/${name}`, appId, installationId);
    }
    throw new IronforgeGitHubProvisionError(SANITIZED_PROVISION_MESSAGE, {
      operation: "get-repo",
      endpoint: `GET /repos/${org}/${name}`,
      appId,
      installationId,
      ...(typeof status === "number" ? { status } : {}),
    });
  }
};

const createRepo = async (
  octokit: AuthenticatedOctokit,
  org: string,
  name: string,
  serviceName: string,
  jobId: string,
  appId: string,
  installationId: string,
): Promise<GitHubRepoResponse> => {
  try {
    const response = await octokit.request("POST /orgs/{org}/repos", {
      org,
      name,
      description: `Ironforge static site · service: ${serviceName}`,
      private: true,
      // auto_init=true seeds the repo with an initial README commit so that
      // generate-code can use the standard Git Data API path (createBlob /
      // createTree / createCommit). Without it, GitHub returns 409 on
      // git/blobs against a Git-empty repo — the architectural intent of
      // "create-repo creates an empty repo, generate-code adds content"
      // doesn't survive contact with GitHub's empty-repo semantics.
      // generate-code recognizes the auto_init commit via three-signal
      // check (message="Initial commit", author=web-flow, tree={README.md})
      // and creates its starter-code commit on top.
      auto_init: true,
      custom_properties: { [CUSTOM_PROPERTY_KEY]: jobId },
    });
    return response.data as unknown as GitHubRepoResponse;
  } catch (err) {
    throw mapHttpError(err, "create-repo", `POST /orgs/${org}/repos`, appId, installationId);
  }
};

// Maps an HTTP error from Octokit to the right Ironforge error class.
// Rate-limit detection is header-based; auth errors are status-based;
// everything else falls into IronforgeGitHubProvisionError.
const mapHttpError = (
  err: unknown,
  operation: "get-repo" | "create-repo",
  endpoint: string,
  appId: string,
  installationId: string,
): Error => {
  const status = (err as { status?: number })?.status;
  const headers = (err as { response?: { headers?: Record<string, string> } })?.response
    ?.headers;
  const rateLimitRemaining = headers?.["x-ratelimit-remaining"];
  const rateLimitReset = headers?.["x-ratelimit-reset"];

  // Rate limited: 403 with x-ratelimit-remaining: 0. The reset
  // timestamp goes to CloudWatch, not into the error context.
  if (status === 403 && rateLimitRemaining === "0") {
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "GitHub rate limit hit",
        operation,
        endpoint,
        appId,
        installationId,
        rateLimitReset,
      }),
    );
    return new IronforgeGitHubRateLimitedError(SANITIZED_RATE_LIMITED_MESSAGE, {
      endpoint,
      appId,
      installationId,
      status: 403,
    });
  }

  // Auth failure (bad token, missing permission, expired). Reuse the
  // existing IronforgeGitHubAuthError class so the SFN Catch routing
  // is consistent with the helper-side auth errors.
  if (status === 401 || status === 403) {
    return new IronforgeGitHubAuthError(
      "GitHub API rejected the installation token",
      {
        mintType: "token-exchange",
        appId,
        installationId,
        endpoint,
        status,
      },
    );
  }

  // Generic provisioning error. Status may be undefined (network-level
  // failure) — context shape allows that.
  return new IronforgeGitHubProvisionError(SANITIZED_PROVISION_MESSAGE, {
    operation,
    endpoint,
    appId,
    installationId,
    ...(typeof status === "number" ? { status } : {}),
  });
};

export type BuildHandlerDeps = {
  // Test injection seam for the installation-token mint. Production
  // code uses the real getInstallationToken from shared-utils.
  getInstallationToken?: (
    params: Parameters<typeof getInstallationToken>[0],
  ) => Promise<InstallationToken>;
  // Test injection seam for the Octokit factory.
  buildOctokit?: (token: string) => AuthenticatedOctokit;
  // Test override for the env-var-backed config. Production passes nothing.
  config?: LambdaConfig;
};

export const buildHandler = (
  deps: BuildHandlerDeps = {},
): ((event: unknown) => Promise<CreateRepoOutput>) => {
  const mintToken = deps.getInstallationToken ?? getInstallationToken;
  const buildOctokit =
    deps.buildOctokit ??
    ((token: string): AuthenticatedOctokit =>
      buildAuthenticatedOctokit({ token }));

  return async (event: unknown): Promise<CreateRepoOutput> => {
    // Step 1 — parse SFN state input.
    const parsed = WorkflowExecutionInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "create-repo received malformed workflow input",
          stepName: STEP_NAME,
          zodIssues: parsed.error.issues,
        }),
      );
      throw new IronforgeWorkflowInputError(SANITIZED_INPUT_PARSE_MESSAGE);
    }
    const input = parsed.data;
    const tableName = getTableName();
    const config = deps.config ?? getConfig();

    // Step 2 — JobStep running.
    await upsertJobStepRunning({
      tableName,
      jobId: input.jobId,
      stepName: STEP_NAME,
    });

    try {
      // Step 3 — fresh installation token (no cache; ADR-008).
      const { token } = await mintToken({
        secretArn: config.secretArn,
        appId: config.appId,
        installationId: config.installationId,
      });

      const octokit = buildOctokit(token);

      // Step 4 — existence check.
      const existence = await checkExistingRepo(
        octokit,
        config.orgName,
        input.serviceName,
        input.jobId,
        config.appId,
        config.installationId,
      );

      let repo: GitHubRepoResponse;
      if (existence.kind === "ours") {
        // Idempotent retry — repo already exists with our jobId.
        repo = existence.repo;
      } else if (existence.kind === "conflict") {
        // Repo exists but isn't ours. Operator cleanup required.
        const conflictErr = new IronforgeGitHubRepoConflictError(
          SANITIZED_REPO_CONFLICT_MESSAGE,
          {
            endpoint: `GET /repos/${config.orgName}/${input.serviceName}`,
            appId: config.appId,
            installationId: config.installationId,
            repoName: input.serviceName,
          },
        );
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "create-repo encountered a name conflict",
            stepName: STEP_NAME,
            jobId: input.jobId,
            repoName: input.serviceName,
          }),
        );
        throw conflictErr;
      } else {
        // Step 5 — create.
        repo = await createRepo(
          octokit,
          config.orgName,
          input.serviceName,
          input.serviceName,
          input.jobId,
          config.appId,
          config.installationId,
        );
      }

      // Step 6 — terminal success.
      const output = buildOutputFromRepo(repo);
      await upsertJobStepSucceeded({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
        output,
      });
      return output;
    } catch (err) {
      // Translate any Ironforge error into a JobStep failed write
      // before re-throwing. SFN's state-level Catch handles the
      // workflow control flow; we just persist the per-step record.
      const errorName = err instanceof Error ? err.name : "Unknown";
      const errorMessage = err instanceof Error ? err.message : String(err);
      await upsertJobStepFailed({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
        errorName,
        errorMessage,
        retryable: false,
      });
      throw err;
    }
  };
};
