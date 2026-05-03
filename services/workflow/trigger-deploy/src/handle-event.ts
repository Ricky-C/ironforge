import {
  type StepName,
} from "@ironforge/shared-types";
import {
  buildAuthenticatedOctokit,
  getInstallationToken,
  getTableName,
  IronforgeGitHubAuthError,
  IronforgeGitHubProvisionError,
  IronforgeGitHubRateLimitedError,
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
  type AuthenticatedOctokit,
  type InstallationToken,
} from "@ironforge/shared-utils";
import sodium from "libsodium-wrappers";
import { z } from "zod";

// Real trigger-deploy Lambda body. Replaces the PR-C.2 stub.
//
// Pipeline (sequential, set-secrets-then-dispatch):
//   1. Parse SFN-supplied state input as HandlerInputSchema. The
//      SFN Parameters block constructs the focused shape from
//      $.steps['create-repo'] and $.steps.run-terraform — the Lambda
//      stays decoupled from the full SFN state.
//   2. JobStep running (natural-key idempotent).
//   3. Mint a fresh installation token (per ADR-008: per-invocation,
//      no cache).
//   4. GET the repo's public key (encrypts every subsequent secret).
//   5. Set 3 secrets sequentially via createOrUpdateRepoSecret. The
//      API is upsert — retries are idempotent. Failure on any one
//      throws IronforgeRepoSecretError; the not-yet-set secrets stay
//      unset, but a retry repopulates from scratch (start at secret
//      1 again — order is fixed but each call is independent).
//   6. Fire createWorkflowDispatch on deploy.yml with the jobId as
//      correlation_id input. workflow_dispatch returns 204 No Content
//      so we don't get a workflowRunId — wait-for-deploy identifies
//      the run via the rendered run-name "Deploy [<jobId>]" instead.
//   7. JobStep succeeded with output { correlationId, repoFullName,
//      workflowFile, dispatchedAt }.
//
// Order matters: secrets BEFORE dispatch. Empty/stale secrets in a
// dispatched run produce unhelpful "AccessDenied" errors at the
// configure-aws-credentials step.
//
// Idempotency caveat: if step 6 succeeds but step 7's JobStep write
// fails and SFN retries this Lambda, a SECOND workflow_dispatch
// fires. wait-for-deploy filters on run-name and picks the newest
// matching run; the second deploy is wasted work but functionally
// idempotent (S3 sync + CloudFront invalidation are idempotent at
// the AWS-API level). Documented in state-machine.md retry table.

const STEP_NAME: StepName = "trigger-deploy";

// File path the platform's deploy.yml lives at within the user's repo.
// Filename (not numeric workflow ID) for workflow_dispatch — durable
// across repo-create cycles, matches what we know at template-author
// time. See PR-C.8 design conversation for the alternatives considered.
const DEPLOY_WORKFLOW_FILE = "deploy.yml" as const;

const SECRET_KEYS = [
  "IRONFORGE_DEPLOY_ROLE_ARN",
  "IRONFORGE_BUCKET_NAME",
  "IRONFORGE_DISTRIBUTION_ID",
] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

const SANITIZED_INPUT_PARSE_MESSAGE =
  "Workflow execution input failed schema validation — see CloudWatch for the offending field";
const SANITIZED_REPO_SECRET_MESSAGE =
  "Failed to set GitHub Actions repo secret — see CloudWatch for the secret name + endpoint";
const SANITIZED_WORKFLOW_DISPATCH_MESSAGE =
  "Failed to fire workflow_dispatch on deploy.yml — see CloudWatch for the underlying response";
const SANITIZED_PROVISION_MESSAGE =
  "GitHub trigger-deploy step failed — see CloudWatch for endpoint + status";

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

export class IronforgeRepoSecretError extends Error {
  override readonly name = "IronforgeRepoSecretError";
}

export class IronforgeWorkflowDispatchError extends Error {
  override readonly name = "IronforgeWorkflowDispatchError";
}

// Static config from env vars. Lazy-on-first-call per
// docs/conventions.md § "Cold-start configuration loading".
type LambdaConfig = {
  secretArn: string;
  appId: string;
  installationId: string;
};

let configCache: LambdaConfig | undefined;
const getConfig = (): LambdaConfig => {
  if (configCache !== undefined) return configCache;
  const secretArn = process.env["GITHUB_APP_SECRET_ARN"];
  const appId = process.env["GITHUB_APP_ID"];
  const installationId = process.env["GITHUB_APP_INSTALLATION_ID"];
  const missing: string[] = [];
  if (!secretArn) missing.push("GITHUB_APP_SECRET_ARN");
  if (!appId) missing.push("GITHUB_APP_ID");
  if (!installationId) missing.push("GITHUB_APP_INSTALLATION_ID");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for trigger-deploy Lambda: ${missing.join(", ")}`,
    );
  }
  configCache = {
    secretArn: secretArn!,
    appId: appId!,
    installationId: installationId!,
  };
  return configCache;
};

export const __resetConfigCacheForTests = (): void => {
  configCache = undefined;
};

// SFN's Parameters block constructs this focused shape — the Lambda
// stays decoupled from the full state. repoFullName is the GitHub
// "<owner>/<repo>" form; defaultBranch is the ref to dispatch against.
export const HandlerInputSchema = z.object({
  jobId: z.string().uuid(),
  serviceId: z.string().uuid(),
  repoFullName: z.string().min(1).regex(/^[^/]+\/[^/]+$/),
  defaultBranch: z.string().min(1),
  deployRoleArn: z.string().min(1),
  bucketName: z.string().min(1),
  distributionId: z.string().min(1),
});

export type HandlerInput = z.infer<typeof HandlerInputSchema>;

export type TriggerDeployOutput = {
  correlationId: string;
  repoFullName: string;
  workflowFile: typeof DEPLOY_WORKFLOW_FILE;
  dispatchedAt: string;
};

const splitRepoFullName = (
  repoFullName: string,
): { owner: string; repo: string } => {
  const slash = repoFullName.indexOf("/");
  // HandlerInputSchema's regex guarantees one slash with non-empty
  // segments either side; this code path is the structural narrow.
  return {
    owner: repoFullName.substring(0, slash),
    repo: repoFullName.substring(slash + 1),
  };
};

// Small wrapper around libsodium's sealed-box. Single-purpose seam so
// tests can stub deterministic encrypted-value output without booting
// WASM in unit-test contexts. Production wires to realEncryptSecret.
export type EncryptSecretFn = (params: {
  value: string;
  publicKeyB64: string;
}) => Promise<string>;

const realEncryptSecret: EncryptSecretFn = async ({ value, publicKeyB64 }) => {
  // First call boots the WASM module (~6ms cold start, no-op afterwards).
  // Subsequent invocations resolve immediately — calling sodium.ready
  // is the documented idempotent gate per libsodium-wrappers' API.
  await sodium.ready;
  const publicKey = sodium.from_base64(
    publicKeyB64,
    sodium.base64_variants.ORIGINAL,
  );
  const messageBytes = sodium.from_string(value);
  const encrypted = sodium.crypto_box_seal(messageBytes, publicKey);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
};

// Octokit response narrowing — only the fields we touch.
type RepoPublicKey = {
  key: string;
  key_id: string;
};

const fetchPublicKey = async (
  octokit: AuthenticatedOctokit,
  owner: string,
  repo: string,
  appId: string,
  installationId: string,
): Promise<RepoPublicKey> => {
  try {
    const response = await octokit.rest.actions.getRepoPublicKey({
      owner,
      repo,
    });
    return { key: response.data.key, key_id: response.data.key_id };
  } catch (err) {
    throw classifyGitHubError(
      err,
      `GET /repos/${owner}/${repo}/actions/secrets/public-key`,
      appId,
      installationId,
    );
  }
};

const setRepoSecret = async (
  octokit: AuthenticatedOctokit,
  owner: string,
  repo: string,
  secretName: SecretKey,
  encryptedValue: string,
  keyId: string,
  appId: string,
  installationId: string,
): Promise<void> => {
  try {
    await octokit.rest.actions.createOrUpdateRepoSecret({
      owner,
      repo,
      secret_name: secretName,
      encrypted_value: encryptedValue,
      key_id: keyId,
    });
  } catch (err) {
    const errorName = err instanceof Error ? err.name : "Unknown";
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "createOrUpdateRepoSecret failed",
        stepName: STEP_NAME,
        endpoint: `PUT /repos/${owner}/${repo}/actions/secrets/${secretName}`,
        secretName,
        appId,
        installationId,
        errorName,
        errorMessage,
      }),
    );
    // Auth + rate-limit errors get the existing typed shapes so the
    // SFN error-class taxonomy applies (same as create-repo). Other
    // errors get the new IronforgeRepoSecretError class.
    const classified = classifyGitHubError(
      err,
      `PUT /repos/${owner}/${repo}/actions/secrets/${secretName}`,
      appId,
      installationId,
    );
    if (classified instanceof IronforgeGitHubProvisionError) {
      throw new IronforgeRepoSecretError(SANITIZED_REPO_SECRET_MESSAGE);
    }
    throw classified;
  }
};

const fireWorkflowDispatch = async (
  octokit: AuthenticatedOctokit,
  owner: string,
  repo: string,
  defaultBranch: string,
  jobId: string,
  appId: string,
  installationId: string,
): Promise<void> => {
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: DEPLOY_WORKFLOW_FILE,
      ref: defaultBranch,
      inputs: {
        correlation_id: jobId,
      },
    });
  } catch (err) {
    const errorName = err instanceof Error ? err.name : "Unknown";
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "createWorkflowDispatch failed",
        stepName: STEP_NAME,
        endpoint: `POST /repos/${owner}/${repo}/actions/workflows/${DEPLOY_WORKFLOW_FILE}/dispatches`,
        defaultBranch,
        appId,
        installationId,
        errorName,
        errorMessage,
      }),
    );
    const classified = classifyGitHubError(
      err,
      `POST /repos/${owner}/${repo}/actions/workflows/${DEPLOY_WORKFLOW_FILE}/dispatches`,
      appId,
      installationId,
    );
    if (classified instanceof IronforgeGitHubProvisionError) {
      throw new IronforgeWorkflowDispatchError(
        SANITIZED_WORKFLOW_DISPATCH_MESSAGE,
      );
    }
    throw classified;
  }
};

// Map raw Octokit errors to Ironforge's error-class taxonomy. Mirrors
// create-repo's mapHttpError: 401/403 → auth; 403+rate-limit → rate-
// limited; everything else → generic provision. Caller may upgrade
// IronforgeGitHubProvisionError to the operation-specific class
// (IronforgeRepoSecretError / IronforgeWorkflowDispatchError).
const classifyGitHubError = (
  err: unknown,
  endpoint: string,
  appId: string,
  installationId: string,
): Error => {
  const status =
    err !== null &&
    typeof err === "object" &&
    "status" in err &&
    typeof err.status === "number"
      ? err.status
      : undefined;
  const headers =
    err !== null &&
    typeof err === "object" &&
    "response" in err &&
    err.response !== null &&
    typeof err.response === "object" &&
    "headers" in err.response &&
    err.response.headers !== null &&
    typeof err.response.headers === "object"
      ? (err.response.headers as Record<string, string>)
      : undefined;
  const rateLimitRemaining = headers?.["x-ratelimit-remaining"];
  const rateLimitReset = headers?.["x-ratelimit-reset"];

  // Rate-limited: 403 with x-ratelimit-remaining: 0. Reset timestamp
  // goes to CloudWatch via the call-site's structured error log, not
  // into the typed context (sanitization).
  if (status === 403 && rateLimitRemaining === "0") {
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "GitHub rate limit hit",
        endpoint,
        appId,
        installationId,
        rateLimitReset,
      }),
    );
    return new IronforgeGitHubRateLimitedError(
      "GitHub rate-limit hit — see CloudWatch for X-RateLimit-Reset value",
      { endpoint, appId, installationId, status: 403 },
    );
  }

  // Auth failure (bad token, missing permission, revoked install).
  // Reuse the existing IronforgeGitHubAuthError class so the SFN
  // Catch routing is consistent with create-repo + the helper-side
  // auth errors.
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

  return new IronforgeGitHubProvisionError(SANITIZED_PROVISION_MESSAGE, {
    operation: "unknown",
    endpoint,
    appId,
    installationId,
    ...(typeof status === "number" ? { status } : {}),
  });
};

export type DateNowMs = () => number;

export type BuildHandlerDeps = {
  config?: LambdaConfig;
  getInstallationToken?: typeof getInstallationToken;
  buildOctokit?: (token: string) => AuthenticatedOctokit;
  encryptSecret?: EncryptSecretFn;
  now?: DateNowMs;
};

export const buildHandler = (
  deps: BuildHandlerDeps = {},
): ((event: unknown) => Promise<TriggerDeployOutput>) => {
  const mintToken = deps.getInstallationToken ?? getInstallationToken;
  const buildOctokit =
    deps.buildOctokit ??
    ((token: string): AuthenticatedOctokit =>
      buildAuthenticatedOctokit({ token }));
  const encryptSecret = deps.encryptSecret ?? realEncryptSecret;
  const now = deps.now ?? Date.now;

  return async (event: unknown): Promise<TriggerDeployOutput> => {
    // Step 1 — parse focused input from SFN Parameters block.
    const parsed = HandlerInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "trigger-deploy received malformed input",
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
      const minted: InstallationToken = await mintToken({
        secretArn: config.secretArn,
        appId: config.appId,
        installationId: config.installationId,
      });
      const octokit = buildOctokit(minted.token);

      const { owner, repo } = splitRepoFullName(input.repoFullName);

      // Step 4 — repo public key. Single fetch; reused for all 3
      // secret encryptions.
      const publicKey = await fetchPublicKey(
        octokit,
        owner,
        repo,
        config.appId,
        config.installationId,
      );

      // Step 5 — set 3 secrets sequentially. Order is fixed; each
      // call is independent (createOrUpdateRepoSecret is upsert), so
      // a mid-sequence retry repopulates from scratch starting at
      // secret 1 — total work is the same as a clean run, no cleanup
      // needed.
      const valuesByKey: Record<SecretKey, string> = {
        IRONFORGE_DEPLOY_ROLE_ARN: input.deployRoleArn,
        IRONFORGE_BUCKET_NAME: input.bucketName,
        IRONFORGE_DISTRIBUTION_ID: input.distributionId,
      };
      for (const secretName of SECRET_KEYS) {
        const encryptedValue = await encryptSecret({
          value: valuesByKey[secretName],
          publicKeyB64: publicKey.key,
        });
        await setRepoSecret(
          octokit,
          owner,
          repo,
          secretName,
          encryptedValue,
          publicKey.key_id,
          config.appId,
          config.installationId,
        );
      }

      // Step 6 — fire workflow_dispatch with correlation_id. Ordering
      // matters: secrets must be set BEFORE the dispatch fires, else
      // the run starts with stale/empty secrets and fails at the
      // configure-aws-credentials step with an unhelpful AccessDenied.
      await fireWorkflowDispatch(
        octokit,
        owner,
        repo,
        input.defaultBranch,
        input.jobId,
        config.appId,
        config.installationId,
      );

      // Step 7 — JobStep succeeded.
      const output: TriggerDeployOutput = {
        correlationId: input.jobId,
        repoFullName: input.repoFullName,
        workflowFile: DEPLOY_WORKFLOW_FILE,
        dispatchedAt: new Date(now()).toISOString(),
      };
      await upsertJobStepSucceeded({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
        output,
      });
      return output;
    } catch (err) {
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
