import {
  buildAuthenticatedOctokit,
  getInstallationToken,
} from "@ironforge/shared-utils";

import type { DeleteGithubRepoOutcome } from "./types.js";

type DeleteGithubRepoInput = {
  // GitHub org owning the repo (e.g. "ironforge-svc").
  owner: string;
  // Repo name = service name.
  repo: string;
  // App auth params. Caller resolves from env / Secrets Manager.
  appAuth: {
    secretArn: string;
    appId: string;
    installationId: string;
  };
};

// Deletes a GitHub repo via App-authenticated Octokit. 404 is treated
// as success ("already absent" detail) — the desired state is "repo
// gone", and it's gone, so the operation is idempotent.
//
// Other HTTP errors return failed with the status code preserved so
// callers can log/branch on it (e.g., 403 → permissions issue,
// network → unknown).
export const deleteGithubRepo = async (
  input: DeleteGithubRepoInput,
): Promise<DeleteGithubRepoOutcome> => {
  const start = Date.now();
  try {
    const { token } = await getInstallationToken({
      secretArn: input.appAuth.secretArn,
      appId: input.appAuth.appId,
      installationId: input.appAuth.installationId,
    });
    const octokit = buildAuthenticatedOctokit({ token });
    await octokit.rest.repos.delete({
      owner: input.owner,
      repo: input.repo,
    });
    return {
      status: "succeeded",
      durationMs: Date.now() - start,
      detail: "deleted",
    };
  } catch (err) {
    const httpStatus = (err as { status?: number })?.status;
    if (httpStatus === 404) {
      return {
        status: "succeeded",
        durationMs: Date.now() - start,
        detail: "already-absent",
      };
    }
    return {
      status: "failed",
      durationMs: Date.now() - start,
      httpStatus,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
