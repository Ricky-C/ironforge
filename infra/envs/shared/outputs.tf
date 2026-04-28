output "artifacts_bucket_name" {
  description = "Name of the shared artifacts bucket. Per-env content under dev/ and prod/ prefixes."
  value       = module.artifacts.bucket_name
}

output "artifacts_bucket_arn" {
  description = "ARN of the shared artifacts bucket. Consumers must scope IAM grants to env prefixes."
  value       = module.artifacts.bucket_arn
}

output "cost_alerts_topic_arn" {
  description = "ARN of the cost-alerts SNS topic. Consumed by future cross-composition Lambdas that fan out to the same alert channel."
  value       = module.cost_safeguards.sns_topic_arn
}

output "cognito_user_pool_id" {
  description = "ID of the shared Cognito user pool."
  value       = module.cognito.user_pool_id
}

output "cognito_user_pool_arn" {
  description = "ARN of the shared Cognito user pool."
  value       = module.cognito.user_pool_arn
}

output "cognito_issuer_url" {
  description = "OIDC issuer URL for the user pool. Used by JWT verifiers."
  value       = module.cognito.issuer_url
}

output "cognito_client_ids" {
  description = "Map of env name to Cognito user pool client ID. Apps MUST verify aud claim against the right env's client_id."
  value       = module.cognito.client_ids
}

output "dns_hosted_zone_id" {
  description = "ID of the ironforge subdomain Route53 hosted zone."
  value       = module.dns.hosted_zone_id
}

output "dns_hosted_zone_arn" {
  description = "ARN of the ironforge subdomain hosted zone. Lambda IAM grants for Route53 actions MUST scope to this ARN."
  value       = module.dns.hosted_zone_arn
}

output "dns_certificate_arn" {
  description = "ARN of the validated wildcard ACM certificate for ironforge.rickycaballero.com (us-east-1)."
  value       = module.dns.certificate_arn
}

output "portal_distribution_id" {
  description = "CloudFront distribution ID for the portal. Used by the app-deploy CI workflow for cache invalidation."
  value       = module.portal_frontend.distribution_id
}

output "portal_distribution_domain_name" {
  description = "CloudFront-assigned domain name for the portal (e.g., d1234.cloudfront.net). Public traffic uses ironforge.rickycaballero.com via Route53 alias."
  value       = module.portal_frontend.distribution_domain_name
}

output "portal_bucket_name" {
  description = "S3 bucket name for the portal origin. The app-deploy CI workflow syncs Next.js export output here."
  value       = module.portal_frontend.bucket_name
}
