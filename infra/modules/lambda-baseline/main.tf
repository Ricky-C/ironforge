# IronforgePermissionBoundary — single managed IAM policy attached as the
# permissions boundary on every Ironforge Lambda execution role.
#
# ALLOW list defines what an inline policy can ever grant. Per-Lambda inline
# policies should be tighter than these (e.g., env-prefix scoping on the
# artifacts bucket happens in inline policies, not here — see ADR-006).
#
# DENY statements are defense in depth — the ALLOW list already doesn't grant
# these, but explicit DENY makes the intent durable against future ALLOW
# widening.
#
# Full design rationale: docs/adrs/006-permission-boundary.md.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  component_tags = {
    "ironforge-component" = "lambda-baseline"
  }
}

resource "aws_iam_policy" "permission_boundary" {
  name        = "IronforgePermissionBoundary"
  description = "Permission boundary for all Ironforge Lambda execution roles. Caps inline policy grants to a known-safe set; explicit DENY statements provide defense in depth. See docs/adrs/006-permission-boundary.md."
  policy      = data.aws_iam_policy_document.permission_boundary.json

  tags = local.component_tags
}

data "aws_iam_policy_document" "permission_boundary" {
  # ===========================================================================
  # ALLOW
  # ===========================================================================

  statement {
    sid    = "AllowLogsForIronforgeLambdas"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/ironforge-*:*",
    ]
  }

  # X-Ray write actions are account-scoped per AWS service authorization
  # reference. See docs/iam-exceptions.md.
  statement {
    sid    = "AllowXRayWrite"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "AllowDynamoDBOnIronforgeTables"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      # TransactWriteItems is its own IAM action distinct from PutItem;
      # POST /api/services uses it to atomically create Service + Job
      # rows. PR-C.2 added.
      "dynamodb:TransactWriteItems",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:DescribeTable",
    ]
    resources = [
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/ironforge-*",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/ironforge-*/index/*",
    ]
  }

  # Boundary allows broadly on the artifacts bucket. Per-Lambda inline
  # policies scope to env prefixes (e.g., bucket_arn/dev/*). See ADR-006
  # § "Why not principal-tag substitution" for why prefix scoping lives
  # in identity policies, not the boundary.
  statement {
    sid    = "AllowArtifactsBucketAccess"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:aws:s3:::ironforge-artifacts-*",
      "arn:aws:s3:::ironforge-artifacts-*/*",
    ]
  }

  statement {
    sid    = "AllowRoute53OnIronforgeZone"
    effect = "Allow"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
    ]
    resources = [var.route53_zone_arn]
  }

  statement {
    sid     = "AllowSNSPublishOnIronforgeTopics"
    effect  = "Allow"
    actions = ["sns:Publish"]
    resources = [
      "arn:aws:sns:${local.region}:${local.account_id}:ironforge-*",
    ]
  }

  statement {
    sid    = "AllowStepFunctionsOnIronforgeStateMachines"
    effect = "Allow"
    actions = [
      "states:StartExecution",
      "states:DescribeExecution",
      "states:GetExecutionHistory",
    ]
    resources = [
      "arn:aws:states:${local.region}:${local.account_id}:stateMachine:ironforge-*",
      "arn:aws:states:${local.region}:${local.account_id}:execution:ironforge-*:*",
    ]
  }

  statement {
    sid     = "AllowSecretsManagerOnIronforgeSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:ironforge/*",
    ]
  }

  # ce:GetCostAndUsage is account-scoped per AWS service authorization
  # reference. See docs/iam-exceptions.md.
  statement {
    sid       = "AllowCostExplorerRead"
    effect    = "Allow"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"]
  }

  statement {
    sid     = "AllowLambdaInvokeOnIronforgeFunctions"
    effect  = "Allow"
    actions = ["lambda:InvokeFunction"]
    resources = [
      "arn:aws:lambda:${local.region}:${local.account_id}:function:ironforge-*",
    ]
  }

  # ===========================================================================
  # DENY (defense in depth)
  # ===========================================================================

  statement {
    sid    = "DenyIAMManagement"
    effect = "Deny"
    actions = [
      "iam:CreateUser",
      "iam:CreateRole",
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:AttachRolePolicy",
      "iam:AttachUserPolicy",
      "iam:PutRolePolicy",
      "iam:PutUserPolicy",
      "iam:DeleteRole",
      "iam:DeleteUser",
      "iam:DeletePolicy",
      "iam:CreateLoginProfile",
      "iam:CreateAccessKey",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "DenySTSAssumeRole"
    effect    = "Deny"
    actions   = ["sts:AssumeRole"]
    resources = ["*"]
  }

  # Mirrors the cost-safeguards deny policy permanently. The deny policy is
  # only attached on budget breach; this boundary keeps these services blocked
  # at all times for Lambdas. Lambdas should never use these services.
  statement {
    sid    = "DenyExpensiveServicesPermanently"
    effect = "Deny"
    actions = [
      "ec2:*",
      "rds:*",
      "redshift:*",
      "elasticache:*",
      "es:*",
      "opensearch:*",
      "sagemaker:*",
      "emr:*",
      "eks:*",
      "ecs:*",
      "kafka:*",
      "memorydb:*",
      "qldb:*",
      "documentdb:*",
    ]
    resources = ["*"]
  }
}
