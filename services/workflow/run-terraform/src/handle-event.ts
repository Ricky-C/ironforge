import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  getOutputsSchema,
  TemplateIdSchema,
  WorkflowExecutionInputSchema,
  type StepName,
  type TemplateId,
  type WorkflowExecutionInput,
} from "@ironforge/shared-types";
import {
  getTableName,
  upsertJobStepFailed,
  upsertJobStepRunning,
  upsertJobStepSucceeded,
} from "@ironforge/shared-utils";

// Real run-terraform Lambda body. Replaces the PR-C.2 stub.
//
// Pipeline:
//   1. Parse SFN input as WorkflowExecutionInput.
//   2. JobStep running (natural-key idempotent).
//   3. Stage per-job working dir at /tmp/<jobId>/:
//      - main.tf           — generated wrapper that imports the template
//                            as a child module + declares root-level
//                            backend "s3" and provider blocks
//      - terraform.tfvars.json — values for the 11 template variables
//      Plus /tmp/.terraformrc with provider_installation { filesystem_mirror }
//      pointing at /opt/.terraform.d/plugins/ so terraform init never
//      contacts registry.terraform.io.
//   4. terraform init  -backend-config=... (per-service S3 state path)
//   5. terraform apply -auto-approve -var-file=terraform.tfvars.json
//   6. terraform output -json — parse + validate against the template's
//      outputsSchema from TEMPLATE_REGISTRY.
//   7. JobStep succeeded with the validated output; cleanup workdir.
//
// On any failure the workdir is still removed in `finally`. SFN's Retry
// MaxAttempts is 0 for this state per ADR-009 — failures route to
// CleanupOnFailure rather than re-running terraform (apply is partial-
// failure-bearing; rerun would compound state, not recover it).

const STEP_NAME: StepName = "run-terraform";

// Pinned to the binary baked into the container image at /opt/bin/.
// Not relying on PATH — Lambda's container PATH includes /opt/bin via the
// AWS Node.js base image but spawn() is more predictable with absolute paths.
const TERRAFORM_BIN = "/opt/bin/terraform";

// CLI config in /tmp because /opt is read-only at runtime. The handler
// rewrites this on every invocation; idempotent across cold/warm starts.
const TF_CLI_CONFIG_PATH = "/tmp/.terraformrc";

// filesystem_mirror is the trust mechanism that makes terraform treat the
// Lambda's bundled provider directory as authoritative. TF_PLUGIN_CACHE_DIR
// alone is INSUFFICIENT — terraform still contacts registry.terraform.io
// to verify versions even on a cache hit, which fails in the no-egress
// Lambda environment with a misleading "Failed to query available provider
// packages" error. The `direct { exclude = ["registry.terraform.io/*/*"] }`
// pairing forces every provider to come from the mirror; any
// future-template that pulls a provider not bundled in the image will fail
// loud at terraform init rather than silently hanging on the network call.
const TF_CLI_CONFIG_CONTENT = `provider_installation {
  filesystem_mirror {
    path    = "/opt/.terraform.d/plugins"
    include = ["registry.terraform.io/hashicorp/aws"]
  }
  direct {
    exclude = ["registry.terraform.io/*/*"]
  }
}
`;

// Truncation budget for stderr in CloudWatch error logs. Terraform's
// stderr on apply failure can be tens of KB; CloudWatch tolerates the
// full payload but log-tail readers don't, and the truncation helps
// keep alert payloads small. Last 4KB captures the actual error frame.
const STDERR_LOG_TAIL_BYTES = 4096;

const SANITIZED_INPUT_PARSE_MESSAGE =
  "Workflow execution input failed schema validation — see CloudWatch for the offending field";
const SANITIZED_INIT_MESSAGE =
  "terraform init failed — see CloudWatch for stderr tail";
const SANITIZED_APPLY_MESSAGE =
  "terraform apply failed — see CloudWatch for stderr tail";
const SANITIZED_DESTROY_MESSAGE =
  "terraform destroy failed — see CloudWatch for stderr tail";
const SANITIZED_ACTION_MESSAGE =
  "Workflow input action must be 'apply' or 'destroy'";
const SANITIZED_OUTPUT_RUN_MESSAGE =
  "terraform output -json failed — see CloudWatch for stderr tail";
const SANITIZED_OUTPUT_PARSE_MESSAGE =
  "terraform output -json was not valid JSON — see CloudWatch";
const SANITIZED_OUTPUT_SCHEMA_MESSAGE =
  "terraform output failed schema validation — see CloudWatch for the offending field";
const SANITIZED_TEMPLATE_ID_MESSAGE =
  "Workflow input declared an unknown templateId — see CloudWatch";

class IronforgeWorkflowInputError extends Error {
  override readonly name = "IronforgeWorkflowInputError";
}

export class IronforgeTerraformInitError extends Error {
  override readonly name = "IronforgeTerraformInitError";
}

export class IronforgeTerraformApplyError extends Error {
  override readonly name = "IronforgeTerraformApplyError";
}

export class IronforgeTerraformDestroyError extends Error {
  override readonly name = "IronforgeTerraformDestroyError";
}

export class IronforgeTerraformOutputError extends Error {
  override readonly name = "IronforgeTerraformOutputError";
}

// Static config from env vars. Lazy-on-first-call per
// docs/conventions.md § "Cold-start configuration loading".
type LambdaConfig = {
  templatePath: string;
  tfstateBucket: string;
  tfstateKmsKeyArn: string;
  awsAccountId: string;
  ironforgeEnv: string;
  ironforgeDomain: string;
  hostedZoneId: string;
  wildcardCertArn: string;
  githubOrg: string;
  githubOidcProviderArn: string;
  permissionBoundaryArn: string;
};

let configCache: LambdaConfig | undefined;

const getConfig = (): LambdaConfig => {
  if (configCache !== undefined) return configCache;
  const env = process.env;
  const required: Record<keyof LambdaConfig, string | undefined> = {
    templatePath: env["TEMPLATE_PATH"],
    tfstateBucket: env["TFSTATE_BUCKET"],
    tfstateKmsKeyArn: env["TFSTATE_KMS_KEY_ARN"],
    awsAccountId: env["AWS_ACCOUNT_ID"],
    ironforgeEnv: env["IRONFORGE_ENV"],
    ironforgeDomain: env["IRONFORGE_DOMAIN"],
    hostedZoneId: env["IRONFORGE_HOSTED_ZONE_ID"],
    wildcardCertArn: env["IRONFORGE_WILDCARD_CERT_ARN"],
    githubOrg: env["IRONFORGE_GITHUB_ORG"],
    githubOidcProviderArn: env["IRONFORGE_GITHUB_OIDC_PROVIDER_ARN"],
    permissionBoundaryArn: env["IRONFORGE_PERMISSION_BOUNDARY_ARN"],
  };
  const missing = Object.entries(required)
    .filter(([, v]) => v === undefined || v === "")
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for run-terraform Lambda: ${missing.join(", ")}`,
    );
  }
  configCache = required as LambdaConfig;
  return configCache;
};

// Test-only — production never resets config. Exported for test isolation.
export const __resetConfigCacheForTests = (): void => {
  configCache = undefined;
};

// Spawn-terraform seam. Real implementation forks the binary; tests inject
// a stub that returns deterministic stdout/stderr/exitCode and asserts the
// args + cwd + env passed.
export type SpawnArgs = {
  cwd: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
};

export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SpawnTerraform = (args: SpawnArgs) => Promise<SpawnResult>;

const realSpawnTerraform: SpawnTerraform = ({ cwd, args, env }) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(TERRAFORM_BIN, args as string[], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });

export type RunTerraformOutput = {
  bucket_name: string;
  distribution_id: string;
  distribution_domain_name: string;
  deploy_role_arn: string;
  live_url: string;
  fqdn: string;
};

// Wrapper main.tf — generated per-invocation. Imports the template as a
// child module via filesystem source. Per the PR-C.6 locked design:
//   - root-level backend "s3" {} (partial; resolved by -backend-config flags)
//   - default + us_east_1-aliased AWS providers (template's required_providers
//     declares configuration_aliases, so the wrapper passes the alias through)
//   - 11 input variables matching templates/static-site/terraform/variables.tf
//   - module "static_site" call wiring all 11 vars
//   - 6 output blocks re-exposing the module's outputs at the wrapper root
//     so `terraform output -json` returns them flat
const buildWrapperMainTf = (templatePath: string, templateId: TemplateId): string => {
  const moduleSource = `${templatePath}/${templateId}/terraform`;
  return `terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
  }
  backend "s3" {}
}

provider "aws" {
  region = "us-east-1"
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

variable "service_name"             { type = string }
variable "service_id"               { type = string }
variable "owner_id"                 { type = string }
variable "environment"              { type = string }
variable "aws_account_id"           { type = string }
variable "wildcard_cert_arn"        { type = string }
variable "hosted_zone_id"           { type = string }
variable "domain_name"              { type = string }
variable "github_org"               { type = string }
variable "github_oidc_provider_arn" { type = string }
variable "permission_boundary_arn"  { type = string }

module "static_site" {
  source = "${moduleSource}"

  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  service_name             = var.service_name
  service_id               = var.service_id
  owner_id                 = var.owner_id
  environment              = var.environment
  aws_account_id           = var.aws_account_id
  wildcard_cert_arn        = var.wildcard_cert_arn
  hosted_zone_id           = var.hosted_zone_id
  domain_name              = var.domain_name
  github_org               = var.github_org
  github_oidc_provider_arn = var.github_oidc_provider_arn
  permission_boundary_arn  = var.permission_boundary_arn
}

output "bucket_name"              { value = module.static_site.bucket_name }
output "distribution_id"          { value = module.static_site.distribution_id }
output "distribution_domain_name" { value = module.static_site.distribution_domain_name }
output "deploy_role_arn"          { value = module.static_site.deploy_role_arn }
output "live_url"                 { value = module.static_site.live_url }
output "fqdn"                     { value = module.static_site.fqdn }
`;
};

const buildTfvars = (
  input: WorkflowExecutionInput,
  config: LambdaConfig,
): Record<string, string> => ({
  service_name: input.serviceName,
  service_id: input.serviceId,
  owner_id: input.ownerId,
  environment: config.ironforgeEnv,
  aws_account_id: config.awsAccountId,
  wildcard_cert_arn: config.wildcardCertArn,
  hosted_zone_id: config.hostedZoneId,
  domain_name: config.ironforgeDomain,
  github_org: config.githubOrg,
  github_oidc_provider_arn: config.githubOidcProviderArn,
  permission_boundary_arn: config.permissionBoundaryArn,
});

const buildBackendConfigArgs = (
  config: LambdaConfig,
  serviceId: string,
): string[] => [
  `-backend-config=bucket=${config.tfstateBucket}`,
  `-backend-config=key=services/${serviceId}/terraform.tfstate`,
  "-backend-config=region=us-east-1",
  "-backend-config=encrypt=true",
  `-backend-config=kms_key_id=${config.tfstateKmsKeyArn}`,
];

// Parses `terraform output -json` payload into a flat map. terraform's
// output JSON shape is `{ <name>: { value, type, sensitive } }`; we drop
// the wrapper and keep `value` per output. Matches the shape expected by
// the per-template outputsSchema.
const flattenTerraformOutputJson = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) {
    throw new IronforgeTerraformOutputError(SANITIZED_OUTPUT_PARSE_MESSAGE);
  }
  const flat: Record<string, unknown> = {};
  for (const [name, wrapper] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof wrapper !== "object" || wrapper === null || !("value" in wrapper)) {
      throw new IronforgeTerraformOutputError(SANITIZED_OUTPUT_PARSE_MESSAGE);
    }
    flat[name] = (wrapper as { value: unknown }).value;
  }
  return flat;
};

export type FsOps = {
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (path: string, content: string, encoding: "utf-8") => Promise<void>;
  rm: (path: string, options: { recursive: true; force: true }) => Promise<void>;
};

const realFsOps: FsOps = {
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, content, encoding) => writeFile(path, content, encoding),
  rm: (path, options) => rm(path, options),
};

export type BuildHandlerDeps = {
  config?: LambdaConfig;
  spawnTerraform?: SpawnTerraform;
  fsOps?: FsOps;
  // Test injection seam for the workdir root. Production hardcodes "/tmp"
  // — Lambda's only writable mount. Tests pass an OS tempdir to avoid
  // colliding with concurrent runs and to allow on-disk inspection.
  workDirRoot?: string;
};

export const buildHandler = (
  deps: BuildHandlerDeps = {},
): ((event: unknown) => Promise<RunTerraformOutput>) => {
  const spawnTerraform = deps.spawnTerraform ?? realSpawnTerraform;
  const fsOps = deps.fsOps ?? realFsOps;
  const workDirRoot = deps.workDirRoot ?? "/tmp";

  return async (event: unknown): Promise<RunTerraformOutput> => {
    // Step 1 — parse SFN state input. Throws BEFORE any DDB write so a
    // malformed event doesn't even create a JobStep entry.
    const parsed = WorkflowExecutionInputSchema.safeParse(event);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "run-terraform received malformed workflow input",
          stepName: STEP_NAME,
          zodIssues: parsed.error.issues,
        }),
      );
      throw new IronforgeWorkflowInputError(SANITIZED_INPUT_PARSE_MESSAGE);
    }
    const input = parsed.data;

    // Step 1b — read action from raw event (not in WorkflowExecutionInputSchema
    // because cleanup-on-failure is the only caller passing it; SFN's normal
    // run-terraform invocation omits the field and gets the default "apply").
    // Added during Phase 1.5 destroy-chain work — see docs/tech-debt.md
    // § "Cleanup-on-failure destroy chain (Promoted)".
    const rawAction = (event as { action?: unknown } | null)?.action ?? "apply";
    if (rawAction !== "apply" && rawAction !== "destroy") {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "run-terraform received invalid action",
          stepName: STEP_NAME,
          jobId: input.jobId,
          action: rawAction,
        }),
      );
      throw new IronforgeWorkflowInputError(SANITIZED_ACTION_MESSAGE);
    }
    const action: "apply" | "destroy" = rawAction;

    // Validate templateId against the canonical enum BEFORE doing any IO.
    // The WorkflowExecutionInputSchema treats templateId as a free-form
    // string (template-agnostic at the workflow boundary), but the
    // outputsSchema lookup needs a registered TemplateId.
    const templateIdParse = TemplateIdSchema.safeParse(input.templateId);
    if (!templateIdParse.success) {
      console.error(
        JSON.stringify({
          level: "ERROR",
          message: "run-terraform received unknown templateId",
          stepName: STEP_NAME,
          jobId: input.jobId,
          templateId: input.templateId,
        }),
      );
      throw new IronforgeWorkflowInputError(SANITIZED_TEMPLATE_ID_MESSAGE);
    }
    const templateId: TemplateId = templateIdParse.data;

    const config = deps.config ?? getConfig();
    const tableName = getTableName();

    // Step 2 — JobStep running (natural-key idempotent). Skipped on
    // destroy: cleanup-on-failure owns its own JobStep#cleanup-on-failure
    // entry, and the failed JobStep#run-terraform from the original apply
    // attempt should NOT be flipped to "running" by the destroy invocation.
    if (action === "apply") {
      await upsertJobStepRunning({
        tableName,
        jobId: input.jobId,
        stepName: STEP_NAME,
      });
    }

    const workDir = join(workDirRoot, input.jobId);
    try {
      // Step 3 — stage workdir + CLI config.
      await fsOps.mkdir(workDir, { recursive: true });
      await fsOps.writeFile(
        join(workDir, "main.tf"),
        buildWrapperMainTf(config.templatePath, templateId),
        "utf-8",
      );
      await fsOps.writeFile(
        join(workDir, "terraform.tfvars.json"),
        JSON.stringify(buildTfvars(input, config), null, 2),
        "utf-8",
      );
      await fsOps.writeFile(TF_CLI_CONFIG_PATH, TF_CLI_CONFIG_CONTENT, "utf-8");

      const spawnEnv: NodeJS.ProcessEnv = {
        ...process.env,
        // Trust mechanism — see TF_CLI_CONFIG_CONTENT comment above.
        TF_CLI_CONFIG_FILE: TF_CLI_CONFIG_PATH,
        // Suppress interactive prompts and CI hints. Defense-in-depth;
        // -input=false on each command also covers prompts.
        TF_IN_AUTOMATION: "1",
        TF_INPUT: "0",
        // Provider needs an explicit region. Lambda exec env doesn't
        // always set this — set it here regardless.
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-east-1",
      };

      // Step 4 — terraform init.
      const initResult = await spawnTerraform({
        cwd: workDir,
        args: [
          "init",
          "-input=false",
          "-no-color",
          ...buildBackendConfigArgs(config, input.serviceId),
        ],
        env: spawnEnv,
      });
      if (initResult.exitCode !== 0) {
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "terraform init failed",
            stepName: STEP_NAME,
            jobId: input.jobId,
            exitCode: initResult.exitCode,
            stderrTail: initResult.stderr.slice(-STDERR_LOG_TAIL_BYTES),
          }),
        );
        throw new IronforgeTerraformInitError(SANITIZED_INIT_MESSAGE);
      }

      // Step 5d — terraform destroy (only when invoked by cleanup-on-failure).
      // Returns a placeholder RunTerraformOutput so the function signature
      // remains stable; the destroy caller (cleanup-on-failure) ignores the
      // return value. Per Phase 1.5 minimum-viable scope, CloudFront-distribution
      // destroys may exceed the Lambda 10-min timeout; that's a known limit
      // and a Phase 2+ async refactor (see docs/tech-debt.md).
      if (action === "destroy") {
        const destroyResult = await spawnTerraform({
          cwd: workDir,
          args: [
            "destroy",
            "-auto-approve",
            "-input=false",
            "-no-color",
            "-var-file=terraform.tfvars.json",
          ],
          env: spawnEnv,
        });
        if (destroyResult.exitCode !== 0) {
          console.error(
            JSON.stringify({
              level: "ERROR",
              message: "terraform destroy failed",
              stepName: STEP_NAME,
              jobId: input.jobId,
              exitCode: destroyResult.exitCode,
              stderrTail: destroyResult.stderr.slice(-STDERR_LOG_TAIL_BYTES),
            }),
          );
          throw new IronforgeTerraformDestroyError(SANITIZED_DESTROY_MESSAGE);
        }
        return {
          bucket_name: "",
          distribution_id: "",
          distribution_domain_name: "",
          deploy_role_arn: "",
          live_url: "",
          fqdn: "",
        };
      }

      // Step 5 — terraform apply.
      const applyResult = await spawnTerraform({
        cwd: workDir,
        args: [
          "apply",
          "-auto-approve",
          "-input=false",
          "-no-color",
          "-var-file=terraform.tfvars.json",
        ],
        env: spawnEnv,
      });
      if (applyResult.exitCode !== 0) {
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "terraform apply failed",
            stepName: STEP_NAME,
            jobId: input.jobId,
            exitCode: applyResult.exitCode,
            stderrTail: applyResult.stderr.slice(-STDERR_LOG_TAIL_BYTES),
          }),
        );
        throw new IronforgeTerraformApplyError(SANITIZED_APPLY_MESSAGE);
      }

      // Step 6 — terraform output -json.
      const outputResult = await spawnTerraform({
        cwd: workDir,
        args: ["output", "-json", "-no-color"],
        env: spawnEnv,
      });
      if (outputResult.exitCode !== 0) {
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "terraform output -json failed",
            stepName: STEP_NAME,
            jobId: input.jobId,
            exitCode: outputResult.exitCode,
            stderrTail: outputResult.stderr.slice(-STDERR_LOG_TAIL_BYTES),
          }),
        );
        throw new IronforgeTerraformOutputError(SANITIZED_OUTPUT_RUN_MESSAGE);
      }

      let rawOutput: unknown;
      try {
        rawOutput = JSON.parse(outputResult.stdout);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "terraform output -json stdout was not valid JSON",
            stepName: STEP_NAME,
            jobId: input.jobId,
            parseError: err instanceof Error ? err.message : String(err),
          }),
        );
        throw new IronforgeTerraformOutputError(SANITIZED_OUTPUT_PARSE_MESSAGE);
      }
      const flattened = flattenTerraformOutputJson(rawOutput);

      const outputsSchema = getOutputsSchema(templateId);
      const outputParsed = outputsSchema.safeParse(flattened);
      if (!outputParsed.success) {
        console.error(
          JSON.stringify({
            level: "ERROR",
            message: "terraform output failed schema validation",
            stepName: STEP_NAME,
            jobId: input.jobId,
            templateId,
            zodIssues: outputParsed.error.issues,
          }),
        );
        throw new IronforgeTerraformOutputError(SANITIZED_OUTPUT_SCHEMA_MESSAGE);
      }
      const output = outputParsed.data as RunTerraformOutput;

      // Step 7 — JobStep succeeded.
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
      // ADR-009: run-terraform's MaxAttempts is 0 — failures route to
      // CleanupOnFailure. Mark the JobStep non-retryable so operators
      // don't re-fire the workflow against partial state.
      // Skipped on destroy: cleanup-on-failure manages its own JobStep
      // entry; the original JobStep#run-terraform=failed should NOT be
      // overwritten by a subsequent destroy attempt's failure.
      if (action === "apply") {
        await upsertJobStepFailed({
          tableName,
          jobId: input.jobId,
          stepName: STEP_NAME,
          errorName,
          errorMessage,
          retryable: false,
        });
      }
      throw err;
    } finally {
      // Cleanup workdir on success AND failure. rm errors are logged but
      // never thrown — a cleanup failure must not mask the original error
      // (which the catch block already converted to a typed throw).
      try {
        await fsOps.rm(workDir, { recursive: true, force: true });
      } catch (rmErr) {
        console.error(
          JSON.stringify({
            level: "WARN",
            message: "failed to remove run-terraform workdir",
            stepName: STEP_NAME,
            jobId: input.jobId,
            workDir,
            error: rmErr instanceof Error ? rmErr.message : String(rmErr),
          }),
        );
      }
    }
  };
};
