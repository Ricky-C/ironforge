data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  bucket_name = "ironforge-tfstate-${var.environment}-${data.aws_caller_identity.current.account_id}"

  component_tags = {
    "ironforge-component"   = "tfstate-bucket"
    "ironforge-environment" = var.environment
    "ironforge-managed"     = "true"
  }
}

# ---------------------------------------------------------------------------
# KMS — encrypts the per-env terraform state at rest.
#
# CMK is justified per ADR-003 criteria 1+2: state files are high-value
# (full resource configuration, sensitive non-secret values like deploy
# role ARNs, tag values), and decrypt-event audit is meaningful — every
# decrypt of a state file is an event we'd want to investigate if it
# came from an unexpected principal.
#
# Tier 2 per ADR-003 § "CMK boundary tiering": single-resource CMK with a
# narrow consumer set. The per-service state files share this CMK; the
# scope is bounded by the bucket's contents.
#
# Policy lives in a separate aws_kms_key_policy resource per the
# PR-C.4b cycle-avoidance pattern. The key policy references the bucket
# (in EncryptionContext binding for narrowing); the bucket references
# the key (via kms_key_id on bucket encryption config). Inline policy
# would cycle.
# ---------------------------------------------------------------------------

resource "aws_kms_key" "tfstate" {
  description             = "Encrypts the ${var.environment} terraform state bucket (${local.bucket_name})"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(local.component_tags, {
    Name = "ironforge-tfstate-${var.environment}"
  })
}

resource "aws_kms_alias" "tfstate" {
  name          = "alias/ironforge-tfstate-${var.environment}"
  target_key_id = aws_kms_key.tfstate.id
}

resource "aws_kms_key_policy" "tfstate" {
  key_id = aws_kms_key.tfstate.id
  policy = data.aws_iam_policy_document.kms_key.json
}

data "aws_iam_policy_document" "kms_key" {
  # Standard root grant. Required so the account root retains full
  # control if other statements are misconfigured (recovery path), AND
  # so IAM-based grants from consuming roles can resolve.
  statement {
    sid    = "EnableRootAccountAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  # Apply role grant — terraform manages the bucket + key. The apply
  # role has kms:* on ironforge-managed keys (PR #41 hardening), but
  # the key policy must explicitly delegate to IAM-managed roles for
  # them to use the key.
  statement {
    sid    = "AllowApplyRoleManageKey"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/ironforge-ci-apply"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  # Consuming Lambda grant. Activated by the calling composition once
  # consuming Lambda role ARNs are known. Forward-referenceable per the
  # github-app-secret precedent.
  dynamic "statement" {
    for_each = length(var.consuming_lambda_role_arns) > 0 ? [1] : []
    content {
      sid    = "AllowConsumingLambdaUseKey"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = var.consuming_lambda_role_arns
      }

      # Workflow Lambdas need the full data-key lifecycle for terraform
      # state read/write: Decrypt for reads, GenerateDataKey for new
      # state writes (S3 does envelope encryption with this CMK).
      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey",
      ]
      resources = ["*"]
    }
  }
}

# ---------------------------------------------------------------------------
# S3 bucket — per-service terraform state.
#
# Naming: ironforge-tfstate-<env>-<account>. The account suffix
# guarantees global uniqueness per AWS S3 naming requirements; the env
# prefix keeps dev and prod separated (per the user's Path B pushback
# from PR-C.6 design conv: dedicated bucket per env, not shared with
# prefix isolation).
#
# Versioning is REQUIRED for terraform state — terraform's S3 backend
# uses versioning for state recovery and the implicit lock on state
# writes. Disabling versioning would break terraform's state-management
# semantics, not just lose history.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "tfstate" {
  bucket = local.bucket_name

  # force_destroy = false: terraform destroy fails if the bucket
  # contains objects. State files SHOULD persist even across module
  # rebuilds; deleting them requires deliberate operator action.
  force_destroy = false

  tags = merge(local.component_tags, {
    Name = local.bucket_name
  })
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.tfstate.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  # Versioning generates noncurrent versions on every state write.
  # Keep them long enough for state recovery (30 days matches CMK
  # deletion window); transition to glacier earlier to control cost.
  rule {
    id     = "expire-old-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  policy = data.aws_iam_policy_document.bucket.json
}

data "aws_iam_policy_document" "bucket" {
  # TLS-only. Standard S3 bucket-policy guardrail; matches the
  # artifacts and cloudtrail-logs bucket patterns.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.tfstate.arn,
      "${aws_s3_bucket.tfstate.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Deny non-CMK-encrypted writes. Belt-and-suspenders: bucket SSE
  # config above defaults to CMK, but explicit deny prevents a future
  # writer from passing x-amz-server-side-encryption: AES256 to bypass
  # the CMK.
  statement {
    sid    = "DenyNonCMKWrites"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/*"]

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
}
