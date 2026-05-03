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
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
  type AuthenticatedOctokit,
  type InstallationToken,
} from "@ironforge/shared-utils";
import {
  IronforgeRenderError,
  renderTree,
} from "@ironforge/template-renderer";

import { STARTER_CODE_FILES } from "./starter-code-snapshot/files.js";

// Real generate-code Lambda body. Replaces the PR-C.2 stub.
//
// Pipeline:
//   1. Parse SFN input as WorkflowExecutionInput.
//   2. JobStep running (natural-key idempotent).
//   3. Render the bundled starter-code tree with the build-time-known
//      placeholder map (SERVICE_NAME, DOMAIN). Per Path A from PR-C.5
//      design conv, runtime placeholders (DEPLOY_ROLE_ARN,
//      BUCKET_NAME, DISTRIBUTION_ID) live as ${{ secrets.X }} in
//      starter-code and are populated by trigger-deploy (PR-C.8).
//   4. Mint installation token + build authenticated Octokit.
//   5. Idempotency check: GET refs/heads/main on the repo. If exists,
//      check the head commit's message for the "(Ironforge job <jobId>)"
//      marker — match → idempotent retry; mismatch → conflict error.
//   6. Otherwise: Git Data API initial commit (blobs → tree → commit
//      → ref). Atomic single commit; orphaned blobs on partial failure
//      are GC'd by GitHub.
//   7. JobStep succeeded with { commitSha, treeSha, fileCount }.
//
// Output flows downstream via SFN $.steps.generate-code. trigger-deploy
// (PR-C.8) reads commitSha when firing workflow_dispatch.

const STEP_NAME: StepName = "generate-code";

const SANITIZED_INPUT_PARSE_MESSAGE =
  "Workflow execution input failed schema validation — see CloudWatch for the offending field";
const SANITIZED_RENDER_MESSAGE =
  "Starter-code render failed — see CloudWatch for unsubstituted placeholders";
const SANITIZED_REF_CONFLICT_MESSAGE =
  "Repo's main branch exists but was not created by this provisioning — operator cleanup required";
const SANITIZED_PROVISION_MESSAGE =
  "GitHub Git Data API call failed — see CloudWatch for endpoint + status";
const SANITIZED_RATE_LIMITED_MESSAGE =
  "GitHub rate-limit hit — see CloudWatch for X-RateLimit-Reset value";
const SANITIZED_PRIOR_STEP_MESSAGE =
  "Workflow input missing $.steps.create-repo output — upstream wiring issue";

// Domain constant. Build-time-known per the substitution boundary.
// Matches the dns module's certificate SAN (PR-C.1).
const IRONFORGE_DOMAIN = "ironforge.rickycaballero.com";

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

class IronforgeRefConflictError extends Error {
  override readonly name = "IronforgeRefConflictError";
}

class IronforgeGenerateError extends Error {
  override readonly name = "IronforgeGenerateError";
}

// Static config from env vars. Lazy-on-first-call per
// docs/conventions.md § "Cold-start configuration loading".
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
      `Missing required env vars for generate-code Lambda: ${missing.join(", ")}`,
    );
  }
  configCache = { secretArn: secretArn!, appId: appId!, installationId: installationId!, orgName: orgName! };
  return configCache;
};

export const __resetConfigCacheForTests = (): void => {
  configCache = undefined;
};

// SFN ResultPath threading: state machine input is WorkflowExecutionInput;
// each prior task's output is layered under $.steps.<stepName>. We need
// $.steps.create-repo's output here.
type CreateRepoOutput = {
  repoFullName: string;
  defaultBranch: string;
  repoId: number;
};

type GenerateCodeInput = {
  steps?: {
    "create-repo"?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const parseCreateRepoOutput = (raw: unknown): CreateRepoOutput | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r["repoFullName"] !== "string" ||
    typeof r["defaultBranch"] !== "string" ||
    typeof r["repoId"] !== "number"
  ) {
    return null;
  }
  return {
    repoFullName: r["repoFullName"],
    defaultBranch: r["defaultBranch"],
    repoId: r["repoId"],
  };
};

const buildCommitMarker = (jobId: string): string =>
  `(Ironforge job ${jobId})`;

// "Add starter code" rather than "Initial commit" because the literal initial
// commit is now the auto_init README from create-repo. This commit adds the
// starter-code tree on top, so its message describes what it does.
const buildCommitMessage = (jobId: string): string =>
  `Add starter code ${buildCommitMarker(jobId)}`;

// Three-signal check for an auto_init-only repo (per PR-Phase1-verify-003
// architectural fix). All three must hold; any divergence means a real
// conflict (someone or something other than auto_init wrote the commit).
//
//   1. Commit message is exactly "Initial commit" (no marker, no extra text).
//   2. Author email matches the GitHub App bot pattern
//      (`<id>+<app-slug>[bot]@users.noreply.github.com`). When auto_init=true
//      is invoked via an installation token, GitHub attributes the commit to
//      the calling App's bot — NOT to the web-flow user (`noreply@github.com`).
//      That web-flow attribution only happens when the README is created via
//      the GitHub UI's "Create README" button.
//   3. Tree contains exactly one entry: README.md.
//
// The third signal requires fetching the tree (one extra API call), but is
// load-bearing — without it, any repo whose first commit happens to use
// "Initial commit" + a bot author would be misidentified as auto_init and
// have its content silently overwritten by generate-code.
const AUTO_INIT_BOT_EMAIL_SUFFIX = "[bot]@users.noreply.github.com";

const isAutoInitCommit = async (
  octokit: AuthenticatedOctokit,
  owner: string,
  repo: string,
  message: string,
  authorEmail: string | undefined,
  treeSha: string,
): Promise<boolean> => {
  if (message !== "Initial commit") return false;
  if (!authorEmail || !authorEmail.endsWith(AUTO_INIT_BOT_EMAIL_SUFFIX)) return false;
  let treeResp;
  try {
    treeResp = await octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha });
  } catch {
    // If we can't read the tree, we can't confirm signal 3 — treat as
    // not-auto-init (i.e., real conflict). Caller will surface as conflict
    // rather than silently overwrite content we couldn't inspect.
    return false;
  }
  const entries = treeResp.data.tree as Array<{ path: string; type: string }>;
  return entries.length === 1 && entries[0]?.path === "README.md" && entries[0]?.type === "blob";
};

export type GenerateCodeOutput = {
  commitSha: string;
  treeSha: string;
  fileCount: number;
};

// Maps an HTTP error from Octokit to the right Ironforge error class.
// Mirrors create-repo's mapHttpError but for generate-code's call sites.
const mapHttpError = (
  err: unknown,
  endpoint: string,
  appId: string,
  installationId: string,
): Error => {
  const status = (err as { status?: number })?.status;
  const headers = (err as { response?: { headers?: Record<string, string> } })?.response
    ?.headers;
  const rateLimitRemaining = headers?.["x-ratelimit-remaining"];
  const rateLimitReset = headers?.["x-ratelimit-reset"];

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
    return new IronforgeGitHubRateLimitedError(SANITIZED_RATE_LIMITED_MESSAGE, {
      endpoint,
      appId,
      installationId,
      status: 403,
    });
  }

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

// Idempotency check: does refs/heads/main already exist? If yes, was it
// created by THIS provisioning (commit-message marker matches our jobId)?
const checkExistingRef = async (
  octokit: AuthenticatedOctokit,
  owner: string,
  repo: string,
  branch: string,
  jobId: string,
  appId: string,
  installationId: string,
): Promise<
  | { kind: "not-found" }
  | { kind: "ours"; commitSha: string; treeSha: string }
  | { kind: "auto-init"; parentSha: string; parentTreeSha: string }
  | { kind: "conflict" }
> => {
  let refResp;
  try {
    refResp = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404 || status === 409) {
      // 404: ref doesn't exist. 409: empty repository (no refs).
      // create-repo now uses auto_init=true so this should be unreachable
      // for fresh repos — but legacy repos created with auto_init=false
      // (or any future repo whose auto_init failed) still take this path.
      return { kind: "not-found" };
    }
    throw mapHttpError(
      err,
      `GET /repos/${owner}/${repo}/git/ref/heads/${branch}`,
      appId,
      installationId,
    );
  }

  const commitSha = (refResp.data.object as { sha: string }).sha;
  let commitResp;
  try {
    commitResp = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: commitSha,
    });
  } catch (err) {
    throw mapHttpError(
      err,
      `GET /repos/${owner}/${repo}/git/commits/${commitSha}`,
      appId,
      installationId,
    );
  }

  const message = (commitResp.data as { message: string }).message ?? "";
  const treeSha = (commitResp.data.tree as { sha: string }).sha;
  const marker = buildCommitMarker(jobId);
  if (message.includes(marker)) {
    return { kind: "ours", commitSha, treeSha };
  }

  // Distinguish auto_init's commit from a real conflict via the three-signal
  // check. Order matters — must check auto-init BEFORE returning conflict,
  // otherwise the auto_init commit would block every fresh repo.
  const authorEmail = (commitResp.data.author as { email?: string } | null)?.email;
  if (await isAutoInitCommit(octokit, owner, repo, message, authorEmail, treeSha)) {
    return { kind: "auto-init", parentSha: commitSha, parentTreeSha: treeSha };
  }
  return { kind: "conflict" };
};

// Atomic initial commit via Git Data API. Returns the commit + tree SHAs.
const createInitialCommit = async (
  octokit: AuthenticatedOctokit,
  owner: string,
  repo: string,
  branch: string,
  files: Record<string, string>,
  jobId: string,
  appId: string,
  installationId: string,
): Promise<{ commitSha: string; treeSha: string }> => {
  // Step 1 — create blob per file. Parallel to minimize wall-clock time
  // (the Octokit retry plugin handles transient failures per-call).
  const blobEntries = Object.entries(files);
  let blobs;
  try {
    blobs = await Promise.all(
      blobEntries.map(async ([path, content]) => {
        const resp = await octokit.rest.git.createBlob({
          owner,
          repo,
          content,
          encoding: "utf-8",
        });
        return { path, sha: resp.data.sha };
      }),
    );
  } catch (err) {
    throw mapHttpError(err, `POST /repos/${owner}/${repo}/git/blobs`, appId, installationId);
  }

  // Step 2 — create tree referencing all blobs. `base_tree` omitted so
  // the tree is rooted from scratch (initial commit).
  let treeResp;
  try {
    treeResp = await octokit.rest.git.createTree({
      owner,
      repo,
      tree: blobs.map(({ path, sha }) => ({
        path,
        mode: "100644",
        type: "blob",
        sha,
      })),
    });
  } catch (err) {
    throw mapHttpError(err, `POST /repos/${owner}/${repo}/git/trees`, appId, installationId);
  }
  const treeSha = treeResp.data.sha;

  // Step 3 — create commit. No `parents` because this is the initial
  // commit. App-authored: GitHub auto-fills author/committer as the
  // App's bot identity when authenticated via installation token.
  let commitResp;
  try {
    commitResp = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: buildCommitMessage(jobId),
      tree: treeSha,
      parents: [],
    });
  } catch (err) {
    throw mapHttpError(err, `POST /repos/${owner}/${repo}/git/commits`, appId, installationId);
  }
  const commitSha = commitResp.data.sha;

  // Step 4 — create ref pointing to the new commit. POST (not PATCH)
  // because the ref doesn't exist yet (we verified that in checkExistingRef).
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
  } catch (err) {
    throw mapHttpError(err, `POST /repos/${owner}/${repo}/git/refs`, appId, installationId);
  }

  return { commitSha, treeSha };
};

// Atomic starter-code commit on top of auto_init's README commit. Same
// blob/tree/commit shape as createInitialCommit, but commit has the auto-init
// as its parent and the ref is updated (not created — main already points
// at the auto-init commit). The new tree omits base_tree so the auto-init
// README is replaced by the starter-code tree (the starter-code template
// includes its own README, so the auto-init placeholder isn't preserved).
const createCommitOnAutoInit = async (
  octokit: AuthenticatedOctokit,
  owner: string,
  repo: string,
  branch: string,
  files: Record<string, string>,
  parentSha: string,
  jobId: string,
  appId: string,
  installationId: string,
): Promise<{ commitSha: string; treeSha: string }> => {
  const blobEntries = Object.entries(files);
  let blobs;
  try {
    blobs = await Promise.all(
      blobEntries.map(async ([path, content]) => {
        const resp = await octokit.rest.git.createBlob({
          owner,
          repo,
          content,
          encoding: "utf-8",
        });
        return { path, sha: resp.data.sha };
      }),
    );
  } catch (err) {
    throw mapHttpError(err, `POST /repos/${owner}/${repo}/git/blobs`, appId, installationId);
  }

  let treeResp;
  try {
    treeResp = await octokit.rest.git.createTree({
      owner,
      repo,
      tree: blobs.map(({ path, sha }) => ({
        path,
        mode: "100644",
        type: "blob",
        sha,
      })),
    });
  } catch (err) {
    throw mapHttpError(err, `POST /repos/${owner}/${repo}/git/trees`, appId, installationId);
  }
  const treeSha = treeResp.data.sha;

  let commitResp;
  try {
    commitResp = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: buildCommitMessage(jobId),
      tree: treeSha,
      parents: [parentSha],
    });
  } catch (err) {
    throw mapHttpError(err, `POST /repos/${owner}/${repo}/git/commits`, appId, installationId);
  }
  const commitSha = commitResp.data.sha;

  // updateRef (PATCH) — main already exists pointing at the auto-init commit;
  // we're fast-forwarding it to the starter-code commit.
  try {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commitSha,
    });
  } catch (err) {
    throw mapHttpError(err, `PATCH /repos/${owner}/${repo}/git/refs/heads/${branch}`, appId, installationId);
  }

  return { commitSha, treeSha };
};

export type BuildHandlerDeps = {
  getInstallationToken?: (
    params: Parameters<typeof getInstallationToken>[0],
  ) => Promise<InstallationToken>;
  buildOctokit?: (token: string) => AuthenticatedOctokit;
  config?: LambdaConfig;
  // Test injection seam for the bundled starter-code files. Production
  // uses the build-time snapshot; tests inject a fixture map.
  starterCodeFiles?: Record<string, string>;
};

export const buildHandler = (
  deps: BuildHandlerDeps = {},
): ((event: unknown) => Promise<GenerateCodeOutput>) => {
  const mintToken = deps.getInstallationToken ?? getInstallationToken;
  const buildOctokit =
    deps.buildOctokit ??
    ((token: string): AuthenticatedOctokit =>
      buildAuthenticatedOctokit({ token }));
  const starterCodeFiles = deps.starterCodeFiles ?? STARTER_CODE_FILES;

  return async (event: unknown): Promise<GenerateCodeOutput> => {
    // Step 1 — parse SFN state input.
    const parsed = WorkflowExecutionInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "generate-code received malformed workflow input",
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
    await upsertJobStepRunning({ tableName, jobId: input.jobId, stepName: STEP_NAME });

    try {
      // Read $.steps.create-repo from the raw event (WorkflowExecutionInputSchema
      // doesn't include $.steps; that's SFN ResultPath wrapper data).
      const rawSteps = (event as GenerateCodeInput)?.steps;
      const createRepoOutput = parseCreateRepoOutput(rawSteps?.["create-repo"]);
      if (createRepoOutput === null) {
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "generate-code missing or malformed $.steps.create-repo",
            stepName: STEP_NAME,
            jobId: input.jobId,
          }),
        );
        throw new IronforgeGenerateError(SANITIZED_PRIOR_STEP_MESSAGE);
      }

      // Step 3 — render starter-code with build-time-known placeholders.
      // Path A from PR-C.5 design conv: only SERVICE_NAME + DOMAIN here;
      // runtime placeholders are handled via repo secrets at trigger-deploy.
      let renderedFiles: Record<string, string>;
      try {
        renderedFiles = renderTree(starterCodeFiles, {
          SERVICE_NAME: input.serviceName,
          DOMAIN: IRONFORGE_DOMAIN,
        });
      } catch (err) {
        if (err instanceof IronforgeRenderError) {
          console.error(
            JSON.stringify({
              level: "ERROR",
              message: "generate-code starter-code render failed",
              stepName: STEP_NAME,
              jobId: input.jobId,
              remaining: err.context.remaining,
            }),
          );
          throw new IronforgeGenerateError(SANITIZED_RENDER_MESSAGE);
        }
        throw err;
      }

      // Step 4 — mint token + Octokit.
      const { token } = await mintToken({
        secretArn: config.secretArn,
        appId: config.appId,
        installationId: config.installationId,
      });
      const octokit = buildOctokit(token);

      // owner/repo split from create-repo's repoFullName.
      const [owner, repo] = createRepoOutput.repoFullName.split("/");
      if (!owner || !repo) {
        throw new IronforgeGenerateError(
          "Malformed repoFullName from create-repo step output",
        );
      }
      const branch = createRepoOutput.defaultBranch;

      // Step 5 — idempotency check.
      const existence = await checkExistingRef(
        octokit,
        owner,
        repo,
        branch,
        input.jobId,
        config.appId,
        config.installationId,
      );

      let commitSha: string;
      let treeSha: string;
      if (existence.kind === "ours") {
        // Idempotent retry — branch already created by THIS provisioning.
        commitSha = existence.commitSha;
        treeSha = existence.treeSha;
      } else if (existence.kind === "conflict") {
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "generate-code: refs/heads/main exists without our jobId marker and is not an auto_init commit",
            stepName: STEP_NAME,
            jobId: input.jobId,
            owner,
            repo,
            branch,
          }),
        );
        throw new IronforgeRefConflictError(SANITIZED_REF_CONFLICT_MESSAGE);
      } else if (existence.kind === "auto-init") {
        // Step 6a — common path: starter-code commit on top of auto_init's
        // README commit. create-repo's auto_init=true makes this the
        // expected case for fresh repos.
        const result = await createCommitOnAutoInit(
          octokit,
          owner,
          repo,
          branch,
          renderedFiles,
          existence.parentSha,
          input.jobId,
          config.appId,
          config.installationId,
        );
        commitSha = result.commitSha;
        treeSha = result.treeSha;
      } else {
        // Step 6b — fallback path: legacy/anomalous repos with no main ref
        // (auto_init=false at create time, or auto_init silently failed).
        // Creates an initial commit and the heads/main ref.
        const result = await createInitialCommit(
          octokit,
          owner,
          repo,
          branch,
          renderedFiles,
          input.jobId,
          config.appId,
          config.installationId,
        );
        commitSha = result.commitSha;
        treeSha = result.treeSha;
      }

      // Step 7 — terminal success.
      const output: GenerateCodeOutput = {
        commitSha,
        treeSha,
        fileCount: Object.keys(renderedFiles).length,
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
