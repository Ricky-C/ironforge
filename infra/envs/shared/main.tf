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
    # PR-C.8 will add: "ironforge-dev-trigger-deploy"
  ]
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
