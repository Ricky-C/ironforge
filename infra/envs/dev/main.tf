# Dev environment composition root.

data "aws_caller_identity" "current" {}

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

module "dynamodb" {
  source = "../../modules/dynamodb"

  environment = var.environment
}

# Read-only API Lambda. Stub in PR-B.2 (see services/api/src/handler.ts);
# PR-B.3 replaces the route bodies with DynamoDB-backed logic. The
# Lambda's IAM grants already include dynamodb_read against the env
# table + GSI1 in anticipation of PR-B.3 — no IAM changes needed when
# the real handlers land.
#
# CI must run `pnpm -F @ironforge/api build` before `terraform plan` so
# services/api/dist/ exists when archive_file zips it. The build is part
# of the apply pipeline; local applies require the same step.
module "api_lambda" {
  source = "../../modules/lambda"

  function_name = "ironforge-${var.environment}-api"
  environment   = var.environment

  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn

  source_dir = "${path.root}/../../../services/api/dist"

  environment_variables = {
    DYNAMODB_TABLE_NAME     = module.dynamodb.table_name
    IRONFORGE_ENV           = var.environment
    POWERTOOLS_SERVICE_NAME = "ironforge-api"
    LOG_LEVEL               = "INFO"
  }

  iam_grants = {
    dynamodb_read = [
      module.dynamodb.table_arn,
      "${module.dynamodb.table_arn}/index/*",
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
