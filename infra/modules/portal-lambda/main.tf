# ECR repository + IAM execution role + CloudWatch log group for the
# Ironforge portal Lambda (ADR-011: Lambda Web Adapter migration).
#
# Per ADR-011 § Pre-implementation, the portal migrates from static
# S3+CloudFront to Lambda Web Adapter (LWA) + container-image Lambda
# across three PRs:
#
#   PR-A (this module): substrate only — ECR repo, IAM execution role,
#     CloudWatch log group. No Lambda function, no Function URL, no
#     CloudFront changes. Substrate is verifiably empty/ready.
#   PR-B: apps/web/Dockerfile + next.config.mjs (output: "standalone")
#     + Lambda function (image-mode) consuming this module's ECR +
#     Function URL (AUTH_AWS_IAM) + CloudFront origin switch (S3 →
#     Function URL with OAC origin_type "lambda") + app-deploy.yml
#     rewrite. Cutover.
#   PR-C: destroy the legacy `ironforge-portal-<account-id>` S3 bucket
#     after PR-B's first-load-latency verification gate passes plus a
#     24-48h stability window.
#
# First-apply bootstrap: this module is safe to apply with no image
# pushed. ECR can be empty; the IAM role and log group don't depend
# on the Lambda function existing. PR-B introduces the Dockerfile +
# CI build pipeline that pushes the first image, then creates the
# Lambda + Function URL consuming this module's outputs.

locals {
  repository_name = "ironforge-portal"
  function_name   = "ironforge-portal"

  log_group_name = "/aws/lambda/${local.function_name}"
  role_name      = "${local.function_name}-execution"

  component_tags = {
    "ironforge-component" = "portal-lambda"
    "ironforge-managed"   = "true"
  }
}

# ============================================================================
# ECR repository
# ============================================================================

resource "aws_ecr_repository" "portal" {
  name = local.repository_name

  # Mutable tags allow CI to overwrite "latest" on each push. The
  # Lambda function (PR-B) references the immutable digest, not the
  # tag, so mutability here only affects the convenience tag, not
  # deployment reproducibility. Mirrors terraform-lambda-image's
  # rationale per ADR-009 PR-C.6.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    # Scan on push surfaces CVE issues in the Next.js bundle, the LWA
    # layer, or the Node.js base image before Lambda picks up the
    # new image. Free; reports via ECR console + EventBridge if a
    # future alarm wires it.
    scan_on_push = true
  }

  encryption_configuration {
    # Default AES256 per ADR-003. Image data is build artifact bytes
    # (Next.js standalone bundle + LWA + Node.js base), not high-value
    # tenant data. CMK criteria 1+2 don't apply: no key-policy
    # enforcement we'd want above IAM-level role grants, and decrypt-
    # event audit isn't meaningful for image pulls (Lambda runtime
    # pulls every cold start).
    encryption_type = "AES256"
  }

  tags = merge(local.component_tags, {
    Name = local.repository_name
  })
}

# ============================================================================
# ECR lifecycle policy: cap retained images
# ============================================================================
#
# Bounds storage cost + repo scan time without losing rollback
# capability. Tag-based filtering matches every image (PR-B's Lambda
# uses immutable digest references; tags are convenience only).
#
# Rollback window bounded by image_retention_count × deploy frequency.
# At 10 retained images and 1 deploy/day, ~10 days of rollback
# capability. Older image references in deployed Lambdas survive on
# AWS's per-region image cache, but any cold start that needs to
# re-pull a deleted image will fail. Bumping image_retention_count is
# the lever for longer rollback windows; cost is ~$0.10/GB-mo per
# retained image (~300-500 MB each per ADR-011's expected size band).

resource "aws_ecr_lifecycle_policy" "portal" {
  repository = aws_ecr_repository.portal.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Retain the ${var.image_retention_count} most recent images; expire older."
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.image_retention_count
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# ============================================================================
# ECR repository policy: allow the Lambda SERVICE to pull the image
# ============================================================================
#
# Container-image Lambdas are pulled by the Lambda service principal
# (lambda.amazonaws.com) on every cold start and on reactivation from
# the Inactive state — NOT by the function's execution role. Granting
# the execution role ecr:BatchGetImage / ecr:GetDownloadUrlForLayer does
# nothing for image retrieval: the function serves only while a warm
# execution environment survives, then fails every cold start with
# StateReasonCode=ImageAccessDenied once those environments are
# reclaimed. (Observed 2026-06: the portal returned CloudFront 502
# BadGatewayException for ~1 month this way — see docs/runbook.md
# "portal BadGatewayException".)
#
# Terraform owns this repository policy, so it OVERWRITES the
# LambdaECRImageRetrievalPolicy statement that the Lambda service would
# otherwise auto-inject. The service-principal grant therefore MUST live
# here explicitly, or it is silently clobbered on the next apply.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

resource "aws_ecr_repository_policy" "portal" {
  repository = aws_ecr_repository.portal.name
  policy     = data.aws_iam_policy_document.repository.json
}

data "aws_iam_policy_document" "repository" {
  statement {
    sid    = "LambdaECRImageRetrievalPolicy"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]

    # Confused-deputy guard: scope the service grant to this account's
    # portal function ARN so it can't be leveraged on behalf of any other
    # Lambda. The function lives in the dev composition; ECR accepts a
    # not-yet-created function ARN here (same forward-reference tolerance
    # as KMS key policies).
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values = [
        "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:${local.function_name}",
      ]
    }
  }
}

# ============================================================================
# Lambda execution role
# ============================================================================

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "portal" {
  name                 = local.role_name
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn

  tags = merge(local.component_tags, {
    Name = local.role_name
  })
}

# Inline policy: CloudWatch Logs (own log group only) + X-Ray write
# (account-scoped per AWS service auth reference). Portal Lambda makes no
# other AWS-API calls — it calls the Ironforge API as a Bearer-authenticated
# client (per ADR-010), not via IAM. Adding more permissions later
# (e.g., DynamoDB reads if portal SSR needs them) will need an explicit
# policy attachment plus boundary-coverage check.
resource "aws_iam_role_policy" "portal_logs" {
  name = "logs"
  role = aws_iam_role.portal.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowOwnLogGroup"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${aws_cloudwatch_log_group.portal.arn}:*"
      },
      {
        # X-Ray write actions are account-scoped; they don't accept
        # resource-level permissions per docs/iam-exceptions.md. Boundary
        # already permits xray:PutTraceSegments/PutTelemetryRecords.
        Sid    = "AllowXRayWrite"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
        ]
        Resource = "*"
      }
    ]
  })
}

# ============================================================================
# CloudWatch log group
# ============================================================================
#
# Created explicitly so retention is set up-front and the log group
# exists before the Lambda function does (PR-B materializes the
# Lambda; this log group is its target). Retention 14 days matches
# the Phase 1 Lambda convention.

resource "aws_cloudwatch_log_group" "portal" {
  name              = local.log_group_name
  retention_in_days = 14

  tags = merge(local.component_tags, {
    Name = local.log_group_name
  })
}
