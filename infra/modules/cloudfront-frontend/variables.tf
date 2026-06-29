variable "domain_name" {
  description = "Public domain name the portal will serve at (e.g., 'ironforge.rickycaballero.com'). Must be covered by the certificate referenced in certificate_arn and resolvable inside the hosted zone referenced in hosted_zone_id."
  type        = string
}

variable "certificate_arn" {
  description = "ARN of a us-east-1 ACM certificate covering domain_name. CloudFront only accepts us-east-1 certs."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID where the portal A/AAAA alias records will be created. Must be the zone for the parent of (or equal to) domain_name."
  type        = string
}

variable "lambda_function_url" {
  description = "Lambda Function URL (https://<url-id>.lambda-url.<region>.on.aws/) for the portal Lambda. Must be authorization_type = AWS_IAM so CloudFront's OAC SigV4 signing is what authorizes the invocation. Sole origin for the portal distribution post-PR-C (the S3 origin substrate that backed the Phase 0 portal was destroyed once the Lambda substrate's cold-start gate + functional checks confirmed it as the production substrate)."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9]+\\.lambda-url\\.[a-z0-9-]+\\.on\\.aws/?$", var.lambda_function_url))
    error_message = "lambda_function_url must be a Lambda Function URL of the form https://<url-id>.lambda-url.<region>.on.aws/"
  }
}

variable "enable_waf" {
  description = "Whether to create + attach the portal WAF web ACL. Default false: the WAF is edge defense-in-depth + a portfolio signal, NOT the control that gates provisioning (Cognito JWT auth + the concurrency-job cap do that), and it sits only on the portal CloudFront path — not the API (AWS WAF cannot attach to an HTTP API). Its one load-bearing function — per-IP rate limiting against a request flood — is replaced for $0 by the portal Lambda's reserved_concurrent_executions cap (see ADR-012). Toggling false DESTROYS the ACL so the ~$9/mo (1 web ACL + 4 rules, prorated hourly) stops accruing; flip true for active demos/interviews. A detached-but-existing ACL still bills, so the toggle gates resource existence via count, not just the CloudFront association."
  type        = bool
  default     = false
}
