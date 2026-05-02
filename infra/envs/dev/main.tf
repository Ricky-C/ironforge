# Dev environment composition root.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Shared (account-level) composition outputs. Same state bucket as this
# composition; different state key. Per ADR-001's composition split:
# resources here that need shared resources read them via remote_state.
data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "ironforge-terraform-state-${data.aws_caller_identity.current.account_id}"
    key    = "ironforge/shared/account/terraform.tfstate"
    region = "us-east-1"
  }
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  # State machine ARN computed up-front so the API Lambda can scope its
  # states:StartExecution grant before the state machine resource exists
  # (terraform graph dependency: API Lambda role → state machine name,
  # state machine → 8 task Lambda ARNs). Naming has to match the
  # step-functions module's local.state_machine_name exactly.
  state_machine_name = "ironforge-${var.environment}-provisioning"
  state_machine_arn  = "arn:aws:states:${local.region}:${local.account_id}:stateMachine:${local.state_machine_name}"
}

module "dynamodb" {
  source = "../../modules/dynamodb"

  environment = var.environment
}

# ===========================================================================
# Workflow task Lambdas (PR-C.2 stubs — see services/workflow/_stub-lib)
# ===========================================================================
#
# 8 task Lambdas, one per state in the provisioning state machine. Each is
# a thin facade over @ironforge/workflow-stub-lib for PR-C.2; PR-C.3+
# replaces handlers one at a time. IAM grants are uniform across the 6
# simple stubs (DynamoDB read+write for JobStep upserts); finalize and
# cleanup-on-failure also need Service/Job transitions but use the same
# table ARN, so the grants set is identical.
#
# CI runs `pnpm -r --filter "@ironforge/workflow-*" build` before plan
# so each dist/ directory exists when archive_file zips it.

locals {
  # Shared environment variables for every task Lambda. DynamoDB table
  # name is the only required env; stub-lib reads tableName via
  # getTableName() at request time.
  task_lambda_env = {
    DYNAMODB_TABLE_NAME     = module.dynamodb.table_name
    IRONFORGE_ENV           = var.environment
    POWERTOOLS_SERVICE_NAME = "ironforge-workflow"
    LOG_LEVEL               = "INFO"
  }

  # Shared iam_grants: every task Lambda reads + writes the env's
  # DynamoDB table (JobStep upserts; finalize/cleanup also do
  # transitionStatus on Service/Job). GSI1 access is included for
  # symmetry — finalize doesn't currently use it but PR-C.9 may.
  task_lambda_iam_grants = {
    dynamodb_read = [
      module.dynamodb.table_arn,
      "${module.dynamodb.table_arn}/index/*",
    ]
    dynamodb_write = [
      module.dynamodb.table_arn,
    ]
  }
}

module "task_validate_inputs" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-validate-inputs"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/validate-inputs/dist"
  environment_variables   = local.task_lambda_env
  iam_grants              = local.task_lambda_iam_grants
}

module "task_create_repo" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-create-repo"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/create-repo/dist"

  # PR-C.4b: real handler. Adds GitHub App-related env vars + IAM grants
  # for Secrets Manager + KMS. SSM-backed identifiers (app id,
  # installation id, org name) are resolved at terraform plan time and
  # baked into the env vars; runtime SSM access is not needed and not
  # granted. Rotation requires a redeploy — acceptable for Phase 1.
  environment_variables = merge(local.task_lambda_env, {
    GITHUB_APP_SECRET_ARN      = data.terraform_remote_state.shared.outputs.github_app_secret_arn
    GITHUB_APP_ID              = data.aws_ssm_parameter.github_app_id.value
    GITHUB_APP_INSTALLATION_ID = data.aws_ssm_parameter.github_app_installation_id.value
    GITHUB_ORG_NAME            = data.aws_ssm_parameter.github_org_name.value
  })

  # The boundary widening (PR-C.4a, ADR-006 amendment) caps these
  # actions broadly with tag conditions; the per-Lambda statements
  # below narrow further with specific ARNs + EncryptionContext binding.
  # Intersection (which permission-boundary semantics evaluate) gives
  # this Lambda only github-app-secret decryption right.
  iam_grants = {
    dynamodb_read  = local.task_lambda_iam_grants.dynamodb_read
    dynamodb_write = local.task_lambda_iam_grants.dynamodb_write
    extra_statements = [
      {
        sid       = "GetGitHubAppSecret"
        actions   = ["secretsmanager:GetSecretValue"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
      },
      {
        sid       = "DecryptGitHubAppSecret"
        actions   = ["kms:Decrypt"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_kms_key_arn]
        conditions = [
          {
            test     = "StringEquals"
            variable = "kms:EncryptionContext:SecretARN"
            values   = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
          },
        ]
      },
    ]
  }
}

# SSM data sources for GitHub App identifiers. Read at terraform plan
# time and baked into the create-repo Lambda's env vars. The apply role
# has ssm:Get* on /ironforge/* from PR #41 hardening.
data "aws_ssm_parameter" "github_app_id" {
  name = data.terraform_remote_state.shared.outputs.ssm_app_id_param
}

data "aws_ssm_parameter" "github_app_installation_id" {
  name = data.terraform_remote_state.shared.outputs.ssm_installation_id_param
}

data "aws_ssm_parameter" "github_org_name" {
  name = data.terraform_remote_state.shared.outputs.ssm_org_name_param
}

module "task_generate_code" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-generate-code"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/generate-code/dist"
  environment_variables   = local.task_lambda_env
  iam_grants              = local.task_lambda_iam_grants
}

module "task_run_terraform" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-run-terraform"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/run-terraform/dist"
  environment_variables   = local.task_lambda_env
  iam_grants              = local.task_lambda_iam_grants
}

module "task_wait_for_cloudfront" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-wait-for-cloudfront"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/wait-for-cloudfront/dist"
  environment_variables   = local.task_lambda_env
  iam_grants              = local.task_lambda_iam_grants
}

module "task_trigger_deploy" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-trigger-deploy"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/trigger-deploy/dist"
  environment_variables   = local.task_lambda_env
  iam_grants              = local.task_lambda_iam_grants
}

module "task_finalize" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-finalize"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/finalize/dist"
  environment_variables   = local.task_lambda_env
  iam_grants              = local.task_lambda_iam_grants
}

module "task_cleanup_on_failure" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-cleanup-on-failure"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/cleanup-on-failure/dist"
  environment_variables   = local.task_lambda_env
  iam_grants              = local.task_lambda_iam_grants
}

# ===========================================================================
# Provisioning state machine
# ===========================================================================

module "provisioning_state_machine" {
  source = "../../modules/step-functions"

  environment = var.environment

  task_lambda_arns = {
    validate_inputs     = module.task_validate_inputs.function_arn
    create_repo         = module.task_create_repo.function_arn
    generate_code       = module.task_generate_code.function_arn
    run_terraform       = module.task_run_terraform.function_arn
    wait_for_cloudfront = module.task_wait_for_cloudfront.function_arn
    trigger_deploy      = module.task_trigger_deploy.function_arn
    finalize            = module.task_finalize.function_arn
    cleanup_on_failure  = module.task_cleanup_on_failure.function_arn
  }
}

# ===========================================================================
# API Lambda
# ===========================================================================
# PR-C.2 expands the API Lambda's surface from read-only (PR-B.3) to
# include POST /api/services. New IAM:
#   - dynamodb_write on the env table for Service+Job creation +
#     IdempotencyRecord cache writes + kickoff transitions
#   - extra_statements for states:StartExecution scoped to the
#     provisioning state machine ARN
# Boundary (lambda-baseline) gained dynamodb:TransactWriteItems in this
# PR — required for the create-Service+create-Job atomic write.
#
# CI must run `pnpm -F @ironforge/api build` before `terraform plan` so
# services/api/dist/ exists when archive_file zips it.
module "api_lambda" {
  source = "../../modules/lambda"

  function_name = "ironforge-${var.environment}-api"
  environment   = var.environment

  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn

  source_dir = "${path.root}/../../../services/api/dist"

  environment_variables = {
    DYNAMODB_TABLE_NAME            = module.dynamodb.table_name
    PROVISIONING_STATE_MACHINE_ARN = local.state_machine_arn
    IRONFORGE_ENV                  = var.environment
    POWERTOOLS_SERVICE_NAME        = "ironforge-api"
    LOG_LEVEL                      = "INFO"
  }

  iam_grants = {
    dynamodb_read = [
      module.dynamodb.table_arn,
      "${module.dynamodb.table_arn}/index/*",
    ]
    dynamodb_write = [
      module.dynamodb.table_arn,
    ]
    extra_statements = [
      {
        sid       = "StartProvisioningExecution"
        actions   = ["states:StartExecution"]
        resources = [local.state_machine_arn]
      },
    ]
  }
}

# Per-env HTTP API. Per the convention codified in ADR-005's
# shared-resource-default exception logic: the JWT authorizer's
# Audience is env-specific (the env's Cognito client_id), and HTTP
# API authorizers bind at the API level (no stage-variable
# substitution in JwtConfiguration.Audience), so per-env audiences
# require per-env APIs. Custom domain support is intentionally
# deferred to a follow-up PR.
module "api_gateway" {
  source = "../../modules/api-gateway"

  api_name    = "ironforge-${var.environment}-api"
  environment = var.environment

  jwt_issuer   = data.terraform_remote_state.shared.outputs.cognito_issuer_url
  jwt_audience = data.terraform_remote_state.shared.outputs.cognito_client_ids[var.environment]

  lambda_invoke_arn    = module.api_lambda.function_invoke_arn
  lambda_function_name = module.api_lambda.function_name
}
