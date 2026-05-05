# Portal frontend: S3 bucket + CloudFront distribution + WAF + Route53 records.
# Single shared instance for ironforge.rickycaballero.com — there is no
# per-env portal (dev runs locally on localhost; prod is the only env that
# needs S3+CloudFront serving).
#
# Bucket starts empty after apply. The app-deploy CI workflow (Commit 13)
# uploads the Next.js static export. CloudFront returns errors until then.

data "aws_caller_identity" "current" {}

locals {
  bucket_name = "ironforge-portal-${data.aws_caller_identity.current.account_id}"

  component_tags = {
    "ironforge-component" = "portal-frontend"
  }
}

# ============================================================================
# S3 origin bucket
# ============================================================================

resource "aws_s3_bucket" "portal" {
  provider = aws.us_east_1

  bucket        = local.bucket_name
  force_destroy = false

  tags = merge(local.component_tags, {
    Name = local.bucket_name
  })
}

resource "aws_s3_bucket_versioning" "portal" {
  provider = aws.us_east_1

  bucket = aws_s3_bucket.portal.id

  versioning_configuration {
    status = "Enabled"
  }
}

# AWS-managed encryption per ADR-003 (Next.js static assets are non-sensitive).
resource "aws_s3_bucket_server_side_encryption_configuration" "portal" {
  provider = aws.us_east_1

  bucket = aws_s3_bucket.portal.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "portal" {
  provider = aws.us_east_1

  bucket = aws_s3_bucket.portal.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "portal" {
  provider = aws.us_east_1

  bucket = aws_s3_bucket.portal.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }

  depends_on = [aws_s3_bucket_versioning.portal]
}

# Bucket policy is applied AFTER the distribution exists so the OAC condition
# can reference the distribution ARN. See depends_on at the bottom.
data "aws_iam_policy_document" "portal_bucket" {
  # Allow the CloudFront service to GetObject when the request's source ARN
  # matches THIS specific distribution. aws:SourceArn (full distribution ARN,
  # not just SourceAccount) is the secure pattern — prevents another
  # distribution in this account from reading the bucket.
  statement {
    sid    = "AllowCloudFrontOAC"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.portal.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.portal.arn]
    }
  }

  # TLS-only deny.
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.portal.arn,
      "${aws_s3_bucket.portal.arn}/*",
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

resource "aws_s3_bucket_policy" "portal" {
  provider = aws.us_east_1

  bucket = aws_s3_bucket.portal.id
  policy = data.aws_iam_policy_document.portal_bucket.json

  depends_on = [
    aws_s3_bucket_public_access_block.portal,
    aws_cloudfront_distribution.portal,
  ]
}

# ============================================================================
# CloudFront Origin Access Control
# ============================================================================

resource "aws_cloudfront_origin_access_control" "portal" {
  provider = aws.us_east_1

  name                              = "ironforge-portal-oac"
  description                       = "OAC for the Ironforge portal S3 origin."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# OAC for the portal Lambda Function URL (ADR-011 PR-B commit 5). CloudFront
# signs origin requests via SigV4; the Function URL is AUTH_AWS_IAM-protected;
# aws_lambda_permission (in shared/main.tf) grants CloudFront's service
# principal to invoke when signed by this OAC. Direct unsigned hits to the
# Function URL fail at IAM auth — preserves the WAF-on-CloudFront guarantee.
resource "aws_cloudfront_origin_access_control" "portal_lambda" {
  provider = aws.us_east_1

  name                              = "ironforge-portal-lambda-oac"
  description                       = "OAC for the Ironforge portal Lambda Function URL origin."
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

locals {
  # Strip the https:// prefix and trailing slash to get the bare hostname
  # CloudFront's origin domain_name expects. Validation on the variable
  # ensures the input matches the Lambda Function URL shape.
  lambda_function_url_hostname = trimsuffix(trimprefix(var.lambda_function_url, "https://"), "/")
}

# ============================================================================
# WAF Web ACL — managed rule groups + IP-based rate limiting
# ============================================================================

resource "aws_wafv2_web_acl" "portal" {
  provider = aws.us_east_1

  name  = "ironforge-portal"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesKnownBadInputsRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesAmazonIpReputationList"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesAmazonIpReputationList"
      sampled_requests_enabled   = true
    }
  }

  # Rate-based rule: 2000 requests per 5-minute window per IP. Block above
  # the threshold. Defense against burst abuse that doesn't trip the managed
  # rule sets. Cheap and meaningful — see CloudWatch metrics if it triggers.
  rule {
    name     = "RateLimitPerIP"
    priority = 4

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = 2000
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitPerIP"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "ironforge-portal"
    sampled_requests_enabled   = true
  }

  tags = local.component_tags
}

# ============================================================================
# Response headers policy — security headers
# ============================================================================

# Attached to the portal distribution's default cache behavior. Sets four
# security headers on every response. All four use override=true so any
# origin-supplied value is replaced — the S3 origin doesn't currently set
# these, but override=true keeps the policy authoritative even if origin
# behavior changes.
#
# Headers shipped:
#   - Strict-Transport-Security: max-age=31536000; includeSubDomains
#       1-year max-age with subdomain coverage. preload=false initially —
#       HSTS preload list registration is a long-term commitment (6-12 month
#       removal window) and should be a deliberate decision, not a side
#       effect of "add security headers." Flip to preload=true and submit
#       at hstspreload.org when ready to commit. includeSubDomains covers
#       Phase 1's `*.ironforge.rickycaballero.com` user-template subdomains,
#       which all enforce HTTPS via their own ACM certs.
#   - X-Content-Type-Options: nosniff
#       Standard MIME-sniffing prevention.
#   - Referrer-Policy: strict-origin-when-cross-origin
#       Modern default. Sends full origin same-origin, only the origin
#       (no path) cross-origin HTTPS, nothing on HTTPS→HTTP downgrades.
#   - Content-Security-Policy: frame-ancestors 'none'
#       Single-directive CSP for clickjacking defense. Modern replacement
#       for legacy X-Frame-Options. Browser support is universal in 2026
#       and frame-ancestors supersedes X-Frame-Options when both are
#       present, so deploying CSP-only avoids shipping a header we'd later
#       remove. Phase 1 will expand this directive to a full CSP including
#       default-src, script-src, style-src, connect-src, img-src, font-src
#       once the Next.js bundle's external dependencies are known (Cognito
#       hosted UI, API Gateway origin, any CDN-hosted fonts/assets).
resource "aws_cloudfront_response_headers_policy" "portal" {
  provider = aws.us_east_1

  name    = "ironforge-portal-security-headers"
  comment = "Security response headers for the Ironforge portal distribution."

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      content_security_policy = "frame-ancestors 'none'"
      override                = true
    }
  }
}

# ============================================================================
# CloudFront distribution
# ============================================================================

resource "aws_cloudfront_distribution" "portal" {
  provider = aws.us_east_1

  enabled         = true
  is_ipv6_enabled = true
  comment         = "Ironforge portal — ${var.domain_name}"
  price_class     = "PriceClass_100"

  # default_root_object retained intentionally — harmless under SSR (Lambda
  # handles "/" regardless of root-object mapping), but preserves rollback
  # symmetry if S3 origin is restored as the default cache behavior (R1 path
  # in docs/runbook.md § 13). Remove only if S3 origin is permanently
  # removed (PR-C scope).
  default_root_object = "index.html"

  web_acl_id = aws_wafv2_web_acl.portal.arn

  aliases = [var.domain_name]

  # S3 origin (ADR-011 PR-B commit 5): retained for rollback safety through
  # PR-B. PR-C destroys the bucket + removes this origin block after the
  # post-cutover stability window passes. The bucket policy still references
  # this distribution's ARN — keeping the origin defined preserves that
  # forward-reference unchanged.
  origin {
    domain_name              = aws_s3_bucket.portal.bucket_regional_domain_name
    origin_id                = "s3-portal"
    origin_access_control_id = aws_cloudfront_origin_access_control.portal.id
  }

  # Lambda Function URL origin (ADR-011 PR-B commit 5): the new default
  # cache behavior origin. CloudFront signs requests via OAC; Lambda
  # validates the SigV4 signature against AWS_IAM auth + the
  # aws_lambda_permission (shared/main.tf) granting cloudfront.amazonaws.com
  # to invoke this distribution's source_arn.
  origin {
    domain_name              = local.lambda_function_url_hostname
    origin_id                = "lambda-portal"
    origin_access_control_id = aws_cloudfront_origin_access_control.portal_lambda.id

    # Lambda Function URLs are HTTPS-only on the standard 443 port.
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "lambda-portal"

    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # AWS-managed cache policy "Managed-CachingOptimized" — cache GET/HEAD
    # without query strings or cookies. ID is stable across all AWS accounts.
    # Cache strategy revisits at subphase 2.5 when Cognito Hosted UI cookies
    # become load-bearing for Lambda's per-user rendering; until then, the
    # placeholder/portal HTML is identical across visitors and aggressive
    # caching is correct.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    response_headers_policy_id = aws_cloudfront_response_headers_policy.portal.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # Access logging is intentionally not configured — see docs/tech-debt.md
  # § "CloudFront access logging not enabled" for the deferral rationale.

  tags = merge(local.component_tags, {
    Name = "ironforge-portal"
  })
}

# ============================================================================
# Route53 alias records
# ============================================================================

resource "aws_route53_record" "portal_a" {
  provider = aws.us_east_1

  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.portal.domain_name
    zone_id                = aws_cloudfront_distribution.portal.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "portal_aaaa" {
  provider = aws.us_east_1

  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.portal.domain_name
    zone_id                = aws_cloudfront_distribution.portal.hosted_zone_id
    evaluate_target_health = false
  }
}
