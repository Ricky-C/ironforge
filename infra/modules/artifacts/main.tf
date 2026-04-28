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
  policy = data.aws_iam_policy_document.tls_only.json

  # Apply public access block first; BlockPublicPolicy can race with policy
  # creation otherwise.
  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}

data "aws_iam_policy_document" "tls_only" {
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
