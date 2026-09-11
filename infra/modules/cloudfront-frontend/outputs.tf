output "distribution_id" {
  description = "ID of the portal CloudFront distribution. Used by the app-deploy CI workflow for cache invalidation after each deploy."
  value       = aws_cloudfront_distribution.portal.id
}

output "distribution_arn" {
  description = "ARN of the portal CloudFront distribution."
  value       = aws_cloudfront_distribution.portal.arn
}

output "distribution_domain_name" {
  description = "CloudFront-assigned domain name (e.g., d1234.cloudfront.net). The portal serves at var.domain_name via Route53 alias; this is the underlying CloudFront domain."
  value       = aws_cloudfront_distribution.portal.domain_name
}

output "waf_web_acl_arn" {
  description = "ARN of the portal WAF web ACL, or null when var.enable_waf is false (the ACL is not created). Reference for cross-resource attachment or auditing."
  value       = one(aws_wafv2_web_acl.portal[*].arn)
}
