output "bucket_name" {
  description = "S3 origin bucket name. Substituted into the user's deploy.yml workflow at code-generation time so `aws s3 sync` knows where to push."
  value       = aws_s3_bucket.origin.bucket
}

output "distribution_id" {
  description = "CloudFront distribution ID. Substituted into the user's deploy.yml so `aws cloudfront create-invalidation` targets the right distribution. Also consumed by the wait-for-cloudfront task Lambda for status polling."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_domain_name" {
  description = "CloudFront-assigned domain name (e.g., d1234.cloudfront.net). Public traffic uses the alias via Route53; this is here for diagnostics + the trigger-deploy Lambda's pre-flight checks."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "deploy_role_arn" {
  description = "ARN of the per-service GitHub Actions OIDC deploy role. Substituted into the user's deploy.yml as the role-to-assume."
  value       = aws_iam_role.deploy.arn
}

output "live_url" {
  description = "Public HTTPS URL for the provisioned site. Written onto Service.liveUrl by the finalize task Lambda."
  value       = "https://${local.fqdn}"
}

output "fqdn" {
  description = "Provisioned subdomain (e.g., my-site.ironforge.rickycaballero.com). Same as live_url without the scheme — exposed separately so consumers don't have to strip https://."
  value       = local.fqdn
}
