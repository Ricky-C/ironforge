import { destroyTerraform } from "./destroy-terraform.js";
import { deleteGithubRepo } from "./delete-github-repo.js";
import { deleteTfstate } from "./delete-tfstate.js";
import type { DestroyChainResult } from "./types.js";

type RunDestroyChainInput = {
  // Inputs threaded through to the per-primitive calls. The package
  // doesn't read these; it forwards. See the per-primitive files for
  // the exact contract of each.
  runTerraformLambdaName: string;
  event: unknown;
  serviceId: string;
  serviceName: string;
  tfstateBucket: string;
  githubOrg: string;
  githubAppAuth: {
    secretArn: string;
    appId: string;
    installationId: string;
  };
};

// Sequential best-effort wrapper. Runs the three primitives in the
// fixed order:
//
//   1. terraform destroy   — must run before tfstate delete (terraform
//      reads state to know what to destroy; deleting it earlier would
//      force destroy into a no-op refresh against an empty state).
//   2. delete GitHub repo  — runs after terraform destroy because the
//      deploy IAM role's terraform-managed lifecycle should be cleaned
//      up before the repo it grants OIDC access for is removed (avoids
//      a transient role-without-repo state).
//   3. delete tfstate file — last, after both AWS-side and GitHub-side
//      cleanup are complete.
//
// Each phase is independent: a failure in one does NOT short-circuit
// the next. Callers inspect each phase's outcome to decide flow control
// — cleanup-on-failure logs and continues regardless; PR 3's
// delete-external-resources Lambda will throw on any failure.
export const runDestroyChain = async (
  input: RunDestroyChainInput,
): Promise<DestroyChainResult> => {
  const terraform = await destroyTerraform({
    runTerraformLambdaName: input.runTerraformLambdaName,
    event: input.event,
  });

  const githubRepo = await deleteGithubRepo({
    owner: input.githubOrg,
    repo: input.serviceName,
    appAuth: input.githubAppAuth,
  });

  const tfstate = await deleteTfstate({
    tfstateBucket: input.tfstateBucket,
    serviceId: input.serviceId,
  });

  return { terraform, githubRepo, tfstate };
};
