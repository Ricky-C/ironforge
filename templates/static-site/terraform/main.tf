locals {
  # Per CLAUDE.md provisioned-resource naming: ironforge-svc-<service-name>-*
  resource_prefix = "ironforge-svc-${var.service_name}"
  bucket_name     = "${local.resource_prefix}-origin"
  deploy_role     = "${local.resource_prefix}-deploy"
  fqdn            = "${var.service_name}.${var.domain_name}"

  # Standard tag set for Ironforge-provisioned user resources, per CLAUDE.md
  # § AWS Resource Conventions. Every resource in this template carries these.
  common_tags = {
    "ironforge-component"    = "static-site"
    "ironforge-environment"  = var.environment
    "ironforge-service-id"   = var.service_id
    "ironforge-service-name" = var.service_name
    "ironforge-owner"        = var.owner_id
    "Name"                   = local.resource_prefix
  }
}

# ---------------------------------------------------------------------------
# Origin S3 bucket
# ---------------------------------------------------------------------------
# Bucket holds the static site's deployed artifacts. CloudFront is the only
# reader (via OAC); public access is fully blocked. Encryption is AWS-managed
# per ADR-003 — operational user content for a single tenant doesn't qualify
# for CMK.

resource "aws_s3_bucket" "origin" {
  bucket = local.bucket_name

  tags = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "origin" {
  bucket = aws_s3_bucket.origin.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "origin" {
  bucket = aws_s3_bucket.origin.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "origin" {
  bucket = aws_s3_bucket.origin.id

  versioning_configuration {
    # Versioning enabled so a bad deploy can be rolled back via the prior
    # object version without re-running the full pipeline. Lifecycle (below)
    # caps storage growth.
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "origin" {
  bucket = aws_s3_bucket.origin.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# Bucket policy: deny everything except CloudFront's service principal
# scoped to *this* distribution (via aws:SourceArn). The OAC's signed
# requests carry SigV4 auth; the bucket trusts CloudFront, not the OAC
# directly.
data "aws_iam_policy_document" "origin" {
  # TLS-only access — defense-in-depth even though all traffic flows
  # through CloudFront which terminates TLS at the edge.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.origin.arn,
      "${aws_s3_bucket.origin.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "AllowCloudFrontOACGet"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.origin.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "origin" {
  bucket = aws_s3_bucket.origin.id
  policy = data.aws_iam_policy_document.origin.json

  # Public-access-block must be in place before the bucket policy, otherwise
  # AWS rejects the policy with "BlockPublicPolicy".
  depends_on = [aws_s3_bucket_public_access_block.origin]
}

# ---------------------------------------------------------------------------
# CloudFront distribution
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "this" {
  provider = aws.us_east_1

  name                              = "${local.resource_prefix}-oac"
  description                       = "OAC for ${local.fqdn}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "this" {
  provider = aws.us_east_1

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [local.fqdn]
  comment             = "Ironforge static-site service ${var.service_name}"
  price_class         = "PriceClass_100" # NA + EU only — Phase 1 cost containment

  origin {
    domain_name              = aws_s3_bucket.origin.bucket_regional_domain_name
    origin_id                = "s3-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.this.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # AWS-managed CachingOptimized policy — sane defaults (TTLs, gzip/brotli).
    # We don't need a custom cache policy for a static site.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    # AWS-managed CORS-S3Origin policy — forwards no headers/cookies/query to
    # S3 (S3 doesn't honor them), keeping the cache key minimal.
    origin_request_policy_id = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf"
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 300
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.wildcard_cert_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Route53 alias record
# ---------------------------------------------------------------------------

resource "aws_route53_record" "this" {
  zone_id = var.hosted_zone_id
  name    = local.fqdn
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}

# ---------------------------------------------------------------------------
# Per-service deploy role (GitHub Actions OIDC)
# ---------------------------------------------------------------------------
# The user's repo's deploy.yml workflow assumes this role via the GitHub
# OIDC provider. Trust scoped to repo:<github_org>/<service_name>:* —
# branches, environments, tags from THIS repo only. No other repos can
# assume it; no other workflows in this repo can assume it under a
# different sub claim.
#
# Permissions are tightly scoped to this service's bucket and CloudFront
# distribution. The IronforgePermissionBoundary is applied as defense-in-
# depth; the inline policy is what actually grants access.

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_org}/${var.service_name}:*"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = local.deploy_role
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  permissions_boundary = var.permission_boundary_arn

  tags = local.common_tags
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid    = "ListBucket"
    effect = "Allow"

    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]

    resources = [aws_s3_bucket.origin.arn]
  }

  statement {
    sid    = "ObjectReadWriteDelete"
    effect = "Allow"

    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
    ]

    resources = ["${aws_s3_bucket.origin.arn}/*"]
  }

  statement {
    sid    = "InvalidateCache"
    effect = "Allow"

    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
      "cloudfront:GetDistribution",
    ]

    resources = [aws_cloudfront_distribution.this.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
