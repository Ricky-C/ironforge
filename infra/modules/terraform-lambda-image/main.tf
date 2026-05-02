# ECR repository for the run-terraform Lambda's container image.
#
# Per ADR-009 § Amendments (PR-C.6): the run-terraform Lambda is
# deployed as a container image (rather than zip+layer) because the
# AWS provider binary exceeds the Lambda layer 250MB cap.
#
# This module creates the ECR repo + lifecycle policy. The Docker
# build itself happens via build-image.sh (CI runs this BEFORE
# terraform plan). The pushed image's digest URI is written to
# .image-uri, which the dev composition reads at plan time to set the
# Lambda's image_uri.
#
# First-apply bootstrap: the repo must exist before build-image.sh can
# push to it. Recovery on first ever apply:
#   1. terraform apply against shared composition with the module
#      placeholder allowed empty — creates the repo.
#   2. CI re-runs: build-image.sh pushes image, dev composition
#      consumes the image URI.
# Post-bootstrap, every CI run is: build-image.sh first → push →
# terraform plan reads .image-uri → terraform apply.

locals {
  repository_name = "ironforge-run-terraform"

  component_tags = {
    "ironforge-component" = "terraform-lambda-image"
    "ironforge-managed"   = "true"
  }
}

resource "aws_ecr_repository" "run_terraform" {
  name = local.repository_name

  # Mutable tags allow CI to overwrite "latest" on each push. The
  # Lambda function references the immutable digest, not the tag, so
  # mutability here only affects the convenience tag, not deployment
  # reproducibility.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    # Scan on push — surfaces CVE issues in the terraform binary or
    # provider before the Lambda picks up the new image. Free; reports
    # via ECR console + EventBridge if a future alarm wires it.
    scan_on_push = true
  }

  encryption_configuration {
    # Default AES256 encryption per ADR-003 — image data is binary
    # tooling, not high-value tenant data. CMK criteria 1+2 don't
    # apply: there's no key-policy enforcement we'd want above
    # IAM-level role grants, and decrypt-event audit isn't meaningful
    # for image pulls (the Lambda runtime pulls every cold start).
    encryption_type = "AES256"
  }

  tags = merge(local.component_tags, {
    Name = local.repository_name
  })
}

# Image lifecycle: retain the most recent N images, expire the rest.
# Bounds storage cost + repo scan time without losing rollback
# capability. Tag-based filtering matches every image (we use immutable
# digest references at the Lambda; tags are convenience only).
resource "aws_ecr_lifecycle_policy" "run_terraform" {
  repository = aws_ecr_repository.run_terraform.name

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

# Repository policy: allow the run-terraform Lambda's execution role
# to pull images. The Lambda runtime calls ecr:BatchGetImage +
# ecr:GetDownloadUrlForLayer when starting a container Lambda from
# this repo's images.
#
# Forward-referenceable: the consuming Lambda role ARN doesn't exist
# until the dev composition applies. AWS ECR accepts non-existent
# role ARNs in repository policies (same pattern as KMS key policies);
# this module applies before the dev composition.
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

resource "aws_ecr_repository_policy" "run_terraform" {
  repository = aws_ecr_repository.run_terraform.name
  policy     = data.aws_iam_policy_document.repository.json
}

data "aws_iam_policy_document" "repository" {
  statement {
    sid    = "AllowRunTerraformLambdaPull"
    effect = "Allow"

    principals {
      type = "AWS"
      identifiers = [
        "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/ironforge-dev-run-terraform-execution",
        # PR-C.6 only adds dev's role. When prod composition lands,
        # append "ironforge-prod-run-terraform-execution".
      ]
    }

    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
  }
}
