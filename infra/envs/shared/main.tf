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

# Portal Lambda substrate (ADR-011): ECR + IAM execution role + log
# group. PR-A creates the substrate; PR-B adds the Lambda function +
# Function URL consuming this module's outputs and switches the
# cloudfront-frontend origin from S3 to the Function URL via OAC; PR-C
# destroys the legacy `ironforge-portal-<account-id>` S3 bucket after
# stable Lambda serving.
module "portal_lambda" {
  source = "../../modules/portal-lambda"

  permissions_boundary_arn = module.lambda_baseline.boundary_policy_arn
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

# ============================================================================
# Portal Lambda function + Function URL (ADR-011 PR-B commit 3)
# ============================================================================
#
# Lambda function consumes the SSM-tracked image URI (Y2 design from ADR-011
# gap-2). .github/workflows/app-deploy.yml writes the real image digest URI
# to /ironforge/portal/image-uri on each deploy via put-parameter --overwrite
# AND directly updates Lambda via aws lambda update-function-code; the data
# source below keeps terraform's view of image_uri in sync. Steady-state
# applies are no-op because state, config (data source value), and actual
# Lambda image_uri all match.
#
# PR-B commit 5 adds the OAC + aws_lambda_permission wiring for CloudFront
# -> Function URL via SigV4 signing. Until then, the Function URL is
# AUTH_AWS_IAM-protected; direct unsigned hits fail at the IAM auth check
# (the desired posture for the verification gate — operator awscurl with
# SigV4 succeeds; unsigned curl fails).

# Import block handles first-apply when app-deploy.yml has already created
# the SSM parameter (workflow_run sequencing means app-deploy runs first).
# After first successful apply, this block becomes a no-op and can be
# removed in a follow-up commit. Leaving it in is harmless.
import {
  to = aws_ssm_parameter.portal_image_uri
  id = "/ironforge/portal/image-uri"
}

resource "aws_ssm_parameter" "portal_image_uri" {
  name = "/ironforge/portal/image-uri"
  type = "String"

  # Initial value used only on first-ever apply when the SSM parameter
  # doesn't already exist. The import block above handles the typical
  # case (app-deploy.yml created it via put-parameter); the lifecycle
  # ignore below ensures terraform doesn't revert app-deploy.yml's
  # subsequent value updates.
  value = "${module.portal_lambda.ecr_repository_url}:placeholder"

  description = "Current portal Lambda image URI. Written by .github/workflows/app-deploy.yml on each deploy via put-parameter --overwrite; read by data.aws_ssm_parameter.portal_image_uri to set the Lambda's image_uri attribute."

  lifecycle {
    # value is managed out-of-band by app-deploy.yml's put-parameter
    # --overwrite. terraform creates with the placeholder URI above
    # but doesn't track subsequent updates.
    ignore_changes = [value]
  }
}

data "aws_ssm_parameter" "portal_image_uri" {
  name = aws_ssm_parameter.portal_image_uri.name
}

resource "aws_lambda_function" "portal" {
  function_name = module.portal_lambda.lambda_function_name
  role          = module.portal_lambda.lambda_role_arn
  package_type  = "Image"
  image_uri     = data.aws_ssm_parameter.portal_image_uri.value

  # 1024 MB matches LWA + Next.js cold-start working set per ADR-011 § Q2.
  # Data-driven bump to 2048 if the first-load-latency gate fails on memory
  # pressure rather than image-pull cold start.
  memory_size = 1024

  # 30s is sufficient for portal page rendering at portfolio scale; API
  # client timeouts cap at the proxy boundary (in-Lambda fetch from the
  # Ironforge API).
  timeout = 30

  # arm64 matches the Dockerfile build (PR-B commit 2 uses buildx + QEMU
  # to produce arm64 images on amd64 runners). Lambda rejects image_uri
  # references with arch mismatch.
  architectures = ["arm64"]

  environment {
    variables = {
      # AWS Lambda Web Adapter readiness check — LWA waits for /api/health
      # to return 200 before forwarding production requests.
      AWS_LWA_READINESS_CHECK_PATH = "/api/health"
      # Standalone server's HTTP port. LWA's default is 8080; matched here
      # to the Dockerfile's PORT env so they agree.
      PORT = "8080"
    }
  }

  tags = {
    "ironforge-component" = "portal-lambda"
  }
}

resource "aws_lambda_function_url" "portal" {
  function_name      = aws_lambda_function.portal.function_name
  authorization_type = "AWS_IAM"

  # PR-B commit 5 adds aws_lambda_permission allowing CloudFront's service
  # principal to invoke this URL via SigV4 (signed by OAC). Until then,
  # direct unsigned hits fail at IAM auth.
}
