data "aws_caller_identity" "current" {}

locals {
  bucket_name = "ironforge-artifacts-${data.aws_caller_identity.current.account_id}"

  component_tags = {
    "ironforge-component" = "artifacts"
  }
}

resource "aws_s3_bucket" "artifacts" {
  bucket = local.bucket_name

  # Explicit force_destroy=false: terraform destroy fails if the bucket
  # contains objects. Removing this guardrail requires a deliberate edit.
  force_destroy = false

  tags = merge(local.component_tags, {
    Name = local.bucket_name
  })
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-S3 (AES256) per ADR-003. Build artifacts are non-sensitive operational
# data; CMK's audit/access-control benefits don't justify the key policy
# complexity. Including the explicit configuration block (rather than relying
# on S3's default-on SSE-S3) so the encryption choice is visible in code.
resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.artifacts.json

  # Apply public access block first; BlockPublicPolicy can race with policy
  # creation otherwise.
  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}

data "aws_iam_policy_document" "artifacts" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    # Both forms are required: the bucket ARN matches bucket-scoped actions
    # (s3:GetBucketAcl, etc.), the /* form matches object-scoped actions
    # (s3:GetObject, etc.).
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # ─────────────────────────────────────────────────────────────────────────
  # DenyCrossEnvObjectAccess and DenyCrossEnvListing are TEMPORARILY DISABLED.
  #
  # Re-enabling requires a redesign and an empirical-refresh-stability gate;
  # see docs/postmortems/2026-04-bucket-policy-refresh-cascade.md for the full
  # incident record and `docs/tech-debt.md` § "Re-enable artifacts cross-env
  # bucket policy after refresh-cascade redesign" for the actionable plan.
  #
  # Empirical correlation (reproduced twice):
  #   - PR #34 applied the policy with these two statements → next apply
  #     (PR #35) hit refresh-time `# bucket has been deleted` drift detection
  #     → cascading destroys of the 5 sub-resources → recreate failed at
  #     `BucketAlreadyExists`.
  #   - PR #37 recovered via import block, restored the policy → next apply
  #     (PR #38) reproduced the same cascade.
  #   - With these two statements absent, applies work cleanly.
  #
  # What CloudTrail diagnostics ruled out (not the cause):
  #   - The apply role's refresh API calls SUCCEEDED — `GetBucketVersioning`,
  #     `GetBucketLifecycle`, etc. with `err=''` in CloudTrail.
  #   - No AccessDenied events from any session on this bucket.
  #   - No NoSuchBucket / 404 on the bucket itself.
  #   - Plan-role permission gap eliminated: zero plan-role events on the
  #     bucket; apply runs its own refresh in this workflow.
  #   - Statement 3's `StringNotLike s3:prefix` doesn't fire on prefix-less
  #     ListBucket (null condition rule confirmed).
  #
  # What we couldn't verify (still hypotheses):
  #   - terraform-aws-provider parsing `${aws:PrincipalTag/...}` substitution
  #     in GetBucketPolicy responses in a way that triggers internal "resource
  #     gone" logic.
  #   - HeadBucket or another refresh API call not surfaced as a CloudTrail
  #     management event (CloudTrail visibility gap on the failing call).
  #
  # The mechanism is unidentified. Empirical correlation is enough to act on,
  # but not enough to confidently re-enable. See the postmortem for the
  # diagnostic procedure that the redesign session must run before merging.
  # ─────────────────────────────────────────────────────────────────────────
}

# Per-env prefix-scoped expiration. Both rules currently use 30 days but are
# split so each can be tuned independently without re-touching the other env's
# behavior. The multipart-abort rule is unfiltered (applies bucket-wide).
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-noncurrent-dev"
    status = "Enabled"

    filter {
      prefix = "dev/"
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "expire-noncurrent-prod"
    status = "Enabled"

    filter {
      prefix = "prod/"
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.artifacts]
}
