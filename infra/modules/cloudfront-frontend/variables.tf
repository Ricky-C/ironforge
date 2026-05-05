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
  description = "Lambda Function URL (https://<url-id>.lambda-url.<region>.on.aws/) for the portal Lambda. Must be authorization_type = AWS_IAM so CloudFront's OAC SigV4 signing is what authorizes the invocation. ADR-011 PR-B commit 5: this is the new default cache behavior origin; the existing S3 origin stays defined-but-unused for rollback safety until PR-C destroys it."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9]+\\.lambda-url\\.[a-z0-9-]+\\.on\\.aws/?$", var.lambda_function_url))
    error_message = "lambda_function_url must be a Lambda Function URL of the form https://<url-id>.lambda-url.<region>.on.aws/"
  }
}
