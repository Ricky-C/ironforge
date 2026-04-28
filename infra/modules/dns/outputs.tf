output "hosted_zone_id" {
  description = "ID of the existing ironforge subdomain hosted zone (resolved via data source). Used by downstream modules (CloudFront, Cognito custom domain) to add records, and by Lambda IAM grants for resource scoping."
  value       = data.aws_route53_zone.ironforge.zone_id
}

output "hosted_zone_arn" {
  description = "ARN of the existing hosted zone. Lambda IAM grants for Route53 actions MUST scope to this ARN — never Resource: \"*\" or the parent zone."
  value       = data.aws_route53_zone.ironforge.arn
}

output "certificate_arn" {
  description = "ARN of the validated wildcard ACM certificate. Use for CloudFront distributions, Cognito custom domain, or other consumers requiring a us-east-1 cert for the ironforge subdomain. Reads from the validation resource so consumers automatically wait for validation."
  value       = aws_acm_certificate_validation.ironforge.certificate_arn
}

output "certificate_domain_name" {
  description = "Primary domain name on the certificate."
  value       = aws_acm_certificate.ironforge.domain_name
}
