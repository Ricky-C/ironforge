data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  trail_name     = "ironforge-main"
  bucket_name    = "ironforge-cloudtrail-logs-${data.aws_caller_identity.current.account_id}"
  log_group_name = "/aws/cloudtrail/ironforge"

  # Constructed up-front so the KMS key policy can reference these ARNs as
  # encryption-context constants without taking a hard dependency on the
  # resources they identify (which would create a cycle: trail depends on
  # KMS key, KMS key policy depends on trail ARN).
  trail_arn     = "arn:${data.aws_partition.current.partition}:cloudtrail:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:trail/${local.trail_name}"
  log_group_arn = "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:${local.log_group_name}"

  component_tags = {
    "ironforge-component" = "cloudtrail"
  }
}

# ---------------------------------------------------------------------------
# KMS — single CMK encrypts both the S3 log bucket and the CloudWatch log
# group. CMK is the right call for audit logs per ADR-003 criteria 1 and 2:
#   1. Key policy expresses access control narrower than IAM alone — the
#      cloudtrail / logs service principals are admitted only with their
#      respective EncryptionContext conditions, which IAM cannot express.
#   2. CloudTrail decrypt events on the key itself become part of the audit
#      trail — chain of custody for the audit log decrypts.
# ---------------------------------------------------------------------------

resource "aws_kms_key" "cloudtrail" {
  description             = "Encrypts the ironforge CloudTrail S3 bucket and CloudWatch log group"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms_key.json

  tags = merge(local.component_tags, {
    Name = "ironforge-cloudtrail-logs"
  })
}

resource "aws_kms_alias" "cloudtrail" {
  name          = "alias/ironforge-cloudtrail-logs"
  target_key_id = aws_kms_key.cloudtrail.id
}

data "aws_iam_policy_document" "kms_key" {
  # Standard root grant. Without this, an erroneous edit to the other
  # statements can orphan the key — only the root principal can recover.
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

  # CloudTrail writes logs to the S3 bucket; S3 calls KMS:GenerateDataKey on
  # CloudTrail's behalf to obtain the per-object data key. The encryption
  # context pin restricts use to keys generated for THIS trail's ARN — a
  # different trail in the same account cannot piggyback on this key.
  statement {
    sid    = "AllowCloudTrailEncrypt"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    actions = [
      "kms:GenerateDataKey*",
      "kms:Decrypt",
    ]

    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = [local.trail_arn]
    }

    # Confused-deputy: the service principal is global, so without this
    # condition the key would be usable by any account whose CloudTrail
    # happens to share our trail-name suffix. Pin to this account.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  # CloudWatch Logs encrypts log events at rest with this same key. The
  # logs.<region>.amazonaws.com principal is regional, so the policy stays
  # tight even though the same statement covers the whole CWL service.
  statement {
    sid    = "AllowCloudWatchLogsEncrypt"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.name}.amazonaws.com"]
    }

    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]

    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = [local.log_group_arn]
    }
  }
}

# ---------------------------------------------------------------------------
# S3 bucket — destination for CloudTrail log files.
#
# Object Lock is enabled at create time (cannot be added retroactively in a
# clean way) with a 90-day default retention in COMPLIANCE mode. Compliance
# mode is one-way: even root cannot shorten or remove the retention until
# the per-object window expires. This is intentional — the bucket holds the
# tamper-evident audit trail and that property must hold against an attacker
# who has compromised an admin role. Operational consequence: `terraform
# destroy` of this composition will fail until the most recent log object's
# retention expires.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "logs" {
  bucket = local.bucket_name

  object_lock_enabled = true

  # force_destroy=false aligns with the compliance-mode posture: deletion
  # of this bucket is a deliberate manual operation, not a Terraform-driven
  # convenience.
  force_destroy = false

  tags = merge(local.component_tags, {
    Name = local.bucket_name
  })
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.cloudtrail.arn
    }
    # bucket_key_enabled reduces KMS GenerateDataKey calls (and therefore
    # request cost) by deriving per-object data keys from a per-bucket key
    # cached for short windows. Free, no security impact.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_object_lock_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 90
    }
  }

  # Object Lock requires versioning; explicit dependency makes the order
  # visible in plan output rather than implicit through resource refs.
  depends_on = [aws_s3_bucket_versioning.logs]
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.bucket_policy.json

  # Apply public access block first; BlockPublicPolicy can race with policy
  # creation otherwise (mirrors the artifacts module pattern).
  depends_on = [aws_s3_bucket_public_access_block.logs]
}

data "aws_iam_policy_document" "bucket_policy" {
  # TLS-only — same pattern as the artifacts bucket. Both forms of the
  # bucket ARN cover bucket-scoped and object-scoped actions respectively.
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
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

  # Defense-in-depth: bucket should never accept unencrypted puts even
  # from root. CloudTrail's PUTs go through SSE-KMS automatically because
  # of the bucket's default encryption config; this DENY catches anything
  # that explicitly opts out (e.g., a manual `aws s3 cp --sse none`).
  statement {
    sid     = "DenyUnencryptedPuts"
    effect  = "Deny"
    actions = ["s3:PutObject"]

    resources = ["${aws_s3_bucket.logs.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  # Defense-in-depth: deny puts encrypted with any key other than ours.
  # StringNotEqualsIfExists so it doesn't conflict with the previous
  # statement (which already denies puts that don't specify a KMS algo).
  statement {
    sid     = "DenyWrongKmsKey"
    effect  = "Deny"
    actions = ["s3:PutObject"]

    resources = ["${aws_s3_bucket.logs.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.cloudtrail.arn]
    }
  }

  # CloudTrail service permissions — required for the trail to write logs
  # to this bucket. SourceArn pinning prevents a misconfigured trail in
  # another account from hijacking our bucket as a sink.
  statement {
    sid    = "AllowCloudTrailGetBucketAcl"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.logs.arn]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid    = "AllowCloudTrailWrite"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    actions = ["s3:PutObject"]
    # CloudTrail writes under AWSLogs/<account-id>/ — scope precisely so
    # this grant doesn't silently authorize writes elsewhere.
    resources = ["${aws_s3_bucket.logs.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  # 90-day current-version expiration aligns with the Object Lock default
  # retention. Lifecycle waits for retention expiry before deleting, so the
  # first object becomes deletable exactly when this rule would act.
  rule {
    id     = "expire-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }
  }

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
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

  depends_on = [aws_s3_bucket_versioning.logs]
}

# ---------------------------------------------------------------------------
# CloudWatch Logs delivery — set up now even though metric filters and
# alarms come in Phase 1 (per docs/tech-debt.md). Wiring the delivery
# pipeline here means Phase 1's filter work is just adding the filter
# resources, not also building the plumbing.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = local.log_group_name
  retention_in_days = 90
  kms_key_id        = aws_kms_key.cloudtrail.arn

  tags = local.component_tags
}

resource "aws_iam_role" "cloudtrail_to_cwl" {
  name               = "ironforge-cloudtrail-to-cwl"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_to_cwl_assume.json

  tags = local.component_tags
}

data "aws_iam_policy_document" "cloudtrail_to_cwl_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    # Same confused-deputy reasoning as the bucket policy.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

resource "aws_iam_role_policy" "cloudtrail_to_cwl" {
  name   = "deliver-events"
  role   = aws_iam_role.cloudtrail_to_cwl.id
  policy = data.aws_iam_policy_document.cloudtrail_to_cwl_permissions.json
}

data "aws_iam_policy_document" "cloudtrail_to_cwl_permissions" {
  statement {
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    # CloudTrail writes streams of the form
    # <log-group>:log-stream:<account-id>_CloudTrail_<region>. Scope to the
    # log-stream child resources of this group only; never grant on a wider
    # ARN.
    resources = ["${aws_cloudwatch_log_group.cloudtrail.arn}:log-stream:*"]
  }
}

# ---------------------------------------------------------------------------
# The trail itself.
#
# Single-region (us-east-1) per the platform's region pinning, but
# include_global_service_events=true so IAM/STS/CloudFront/Route53 still
# land in the trail (those services emit through us-east-1).
#
# IMPORTANT: exactly one trail in the account should have
# include_global_service_events=true. If a future multi-region trail is
# added (e.g., to satisfy a compliance regime or pair with GuardDuty), this
# flag must be flipped to false here, otherwise global events will be
# logged twice.
# ---------------------------------------------------------------------------

resource "aws_cloudtrail" "main" {
  name           = local.trail_name
  s3_bucket_name = aws_s3_bucket.logs.id

  is_multi_region_trail         = false
  include_global_service_events = true
  enable_logging                = true

  # SHA-256 digest files written hourly to a *-CloudTrail-Digest/ prefix.
  # Lets you cryptographically prove the log chain wasn't tampered with
  # after the fact. Cost is negligible.
  enable_log_file_validation = true

  kms_key_id = aws_kms_key.cloudtrail.arn

  cloud_watch_logs_group_arn = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn  = aws_iam_role.cloudtrail_to_cwl.arn

  tags = local.component_tags

  # Trail creation validates the bucket policy and CWL role at the API
  # level — both must be in place before the trail comes up.
  depends_on = [
    aws_s3_bucket_policy.logs,
    aws_iam_role_policy.cloudtrail_to_cwl,
  ]
}
