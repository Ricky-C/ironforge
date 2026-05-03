# Shared (account-level) composition root.
# Resources here apply once per AWS account, not per env.
# See docs/adrs/001-shared-env-composition.md for the rationale.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  # Workflow Lambda function names (per env) that consume the GitHub App
  # secret. Each entry's role ARN gets added to the github-app CMK key
  # policy below. PR-C.4b adds create-repo for dev; PR-C.8 will append
  # trigger-deploy. When prod composition lands, prod's Lambdas append
  # here too.
  #
  # Hardcoded list (vs tfvars) because the entries are reviewable, the
  # names are deterministic, and the cost of getting them wrong (missing
  # consumer = first invocation auth-fails loudly) is low and recoverable.
  github_app_consuming_lambda_function_names = [
    "ironforge-dev-create-repo",
    "ironforge-dev-generate-code",
    # PR-C.8 will add: "ironforge-dev-trigger-deploy"
  ]

  # Workflow Lambdas (per env) that read/write per-service terraform
  # state in the env-specific tfstate bucket. PR-C.6 adds run-terraform;
  # PR-C.9 (or future cleanup-on-failure destroy-chain) may add more.
  tfstate_consuming_lambda_function_names_dev = [
    "ironforge-dev-run-terraform",
  ]

  # Prod has no provisioning Lambdas yet — list stays empty until the
  # prod composition lands. Empty list keeps the dynamic statement in
  # tfstate-bucket's CMK key policy disabled until needed.
  tfstate_consuming_lambda_function_names_prod = []
}

module "lambda_baseline" {
  source = "../../modules/lambda-baseline"

  route53_zone_arn = module.dns.hosted_zone_arn
}

module "cost_safeguards" {
  source = "../../modules/cost-safeguards"

  alert_email                 = var.alert_email
  budget_action_target_roles  = var.budget_action_target_roles
  budget_action_target_users  = var.budget_action_target_users
  budget_action_target_groups = var.budget_action_target_groups
  permissions_boundary_arn    = module.lambda_baseline.boundary_policy_arn
}

module "artifacts" {
  source = "../../modules/artifacts"
}

module "cognito" {
  source = "../../modules/cognito"

  clients = {
    dev = {
      callback_urls = ["http://localhost:3000/api/auth/callback/cognito"]
      logout_urls   = ["http://localhost:3000"]
    }
    prod = {
      callback_urls = ["https://ironforge.rickycaballero.com/api/auth/callback/cognito"]
      logout_urls   = ["https://ironforge.rickycaballero.com"]
    }
  }
}

module "dns" {
  source = "../../modules/dns"

  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  domain_name = "ironforge.rickycaballero.com"
}

module "portal_frontend" {
  source = "../../modules/cloudfront-frontend"

  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  domain_name     = "ironforge.rickycaballero.com"
  certificate_arn = module.dns.certificate_arn
  hosted_zone_id  = module.dns.hosted_zone_id
}

module "cloudtrail" {
  source = "../../modules/cloudtrail"
}

module "tfstate_dev" {
  source = "../../modules/tfstate-bucket"

  environment = "dev"

  # Consuming Lambda role ARNs constructed deterministically (same
  # forward-referenceable pattern as github-app-secret). PR-C.6 adds
  # run-terraform; future destroy-chain work may add more.
  consuming_lambda_role_arns = [
    for name in local.tfstate_consuming_lambda_function_names_dev :
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${name}-execution"
  ]
}

# Prod tfstate bucket apples-to-apples with dev. Per-env CMKs and
# per-env consumer lists; the module enforces no cross-env reuse.
module "tfstate_prod" {
  source = "../../modules/tfstate-bucket"

  environment = "prod"

  consuming_lambda_role_arns = [
    for name in local.tfstate_consuming_lambda_function_names_prod :
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${name}-execution"
  ]
}

module "terraform_lambda_image" {
  source = "../../modules/terraform-lambda-image"
  # Versions take the module defaults (terraform 1.10.4, aws provider
  # 5.83.0, arm64). Bumping requires updating both build-image.sh
  # constants AND the module variable defaults — the variables are
  # documentation; the script's constants are the truth.
}

module "github_app_secret" {
  source = "../../modules/github-app-secret"

  org_name        = var.github_org_name
  app_id          = var.github_app_id
  installation_id = var.github_app_installation_id

  # Consuming Lambda role ARNs are constructed deterministically from
  # function names + the lambda module's `${function_name}-execution`
  # naming convention. AWS IAM accepts forward-referenced role ARNs in
  # key policies — the shared composition can apply before dev applies,
  # and the dev Lambda's first invocation succeeds as long as the key
  # policy is in place by then. See PR-C.4b design conv (memory:
  # project_phase1_inheritance.md § "Recommended next step — PR-C.4b").
  workflow_lambda_role_arns = [
    for name in local.github_app_consuming_lambda_function_names :
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${name}-execution"
  ]
}
