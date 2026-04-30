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

  # Cross-env object-access denial. Defense-in-depth third layer behind the
  # permission boundary (broad ALLOW on ironforge-artifacts-*) and per-Lambda
  # inline policies (env-prefix scope). This catches inline grants that
  # mistakenly omit the env prefix — e.g., `${bucket_arn}/*` instead of
  # `${bucket_arn}/dev/*`. See ADR-006 § "What we lose" for the layered model.
  #
  # Mechanism: principal-tag substitution into not_resources. Every Ironforge
  # role carries an `ironforge-environment` tag via the env composition's
  # provider default_tags (dev → "dev", prod → "prod", shared → "shared").
  # The principal's own env prefix and the bucket ARN itself stay exempt;
  # everything else under the bucket gets denied for ironforge-managed
  # principals.
  #
  # Action wildcard `s3:*` is intentional. Enumerating object actions
  # (s3:*Object*) misses real surface — s3:AbortMultipartUpload,
  # s3:CreateMultipartUpload, s3:ReplicateDelete, s3:BypassGovernanceRetention
  # don't match that pattern. With the bucket-ARN exemption in not_resources,
  # bucket-level operations (apply role's GetBucketPolicy etc.) still pass.
  #
  # Untagged principals (operator IAM users, AWS service principals) are
  # exempt by the `ironforge-managed=true` condition. This is intentional:
  # the protection targets automated identities; human break-glass / debug
  # access via untagged user identities is preserved.
  statement {
    sid     = "DenyCrossEnvObjectAccess"
    effect  = "Deny"
    actions = ["s3:*"]

    not_resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/$${aws:PrincipalTag/ironforge-environment}/*",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalTag/ironforge-managed"
      values   = ["true"]
    }
  }

  # Cross-env listing denial. ListBucket operates on the bucket ARN, not on
  # object ARNs, so prefix scoping comes from the s3:prefix request condition
  # rather than from resource matching. Listing without a prefix or with a
  # prefix outside the principal's env is denied; same ironforge-managed gate
  # as DenyCrossEnvObjectAccess so untagged operators stay exempt.
  statement {
    sid    = "DenyCrossEnvListing"
    effect = "Deny"
    actions = [
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:ListBucketMultipartUploads",
    ]
    resources = [aws_s3_bucket.artifacts.arn]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalTag/ironforge-managed"
      values   = ["true"]
    }

    condition {
      test     = "StringNotLike"
      variable = "s3:prefix"
      values   = ["$${aws:PrincipalTag/ironforge-environment}/*"]
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
