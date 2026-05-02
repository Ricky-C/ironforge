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
  description = "ARN of the validated apex+wildcard ACM certificate for ironforge.rickycaballero.com (us-east-1). Covers BOTH the portal apex and every provisioned static-site subdomain via the wildcard SAN — no per-service cert issuance. Consumed cross-composition by the run-terraform Lambda (PR-C.6) when applying templates/static-site/terraform/."
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

output "permission_boundary_arn" {
  description = "ARN of the IronforgePermissionBoundary. Future Lambda-creating modules in dev/prod compositions reference this via terraform_remote_state to apply the boundary to their roles."
  value       = module.lambda_baseline.boundary_policy_arn
}

output "cloudtrail_trail_arn" {
  description = "ARN of the account's CloudTrail trail. Phase 1 metric-filter modules consume this via terraform_remote_state."
  value       = module.cloudtrail.trail_arn
}

output "cloudtrail_log_group_arn" {
  description = "ARN of the CloudWatch log group receiving CloudTrail events. Phase 1 metric filters target this group."
  value       = module.cloudtrail.log_group_arn
}

output "cloudtrail_log_group_name" {
  description = "Name of the CloudWatch log group receiving CloudTrail events."
  value       = module.cloudtrail.log_group_name
}

output "cloudtrail_kms_key_arn" {
  description = "ARN of the CMK encrypting CloudTrail logs (both S3 bucket and CWL log group). Consumers must scope grants via the appropriate kms:EncryptionContext condition."
  value       = module.cloudtrail.kms_key_arn
}

output "github_app_secret_arn" {
  description = "ARN of the GitHub App private key Secrets Manager entry. Workflow Lambda IAM grants for secretsmanager:GetSecretValue MUST scope to this exact ARN."
  value       = module.github_app_secret.secret_arn
}

output "github_app_kms_key_arn" {
  description = "ARN of the CMK encrypting the GitHub App private key. Workflow Lambda IAM grants for kms:Decrypt MUST scope to this ARN AND condition on kms:EncryptionContext:SecretARN matching github_app_secret_arn."
  value       = module.github_app_secret.kms_key_arn
}

output "github_app_ssm_parameter_path" {
  description = "Path prefix for tenant-specific GitHub App SSM parameters (/ironforge/github-app). Workflow Lambda IAM grants for ssm:GetParameter scope to this path."
  value       = module.github_app_secret.ssm_parameter_path
}

# Individual SSM parameter names re-exported so env compositions can
# read parameter values via aws_ssm_parameter data sources at plan time
# without re-deriving the parameter paths. PR-C.4b: dev's create-repo
# Lambda bakes these values into env vars.
output "github_app_ssm_org_name_param" {
  description = "SSM parameter name holding the GitHub org name."
  value       = module.github_app_secret.ssm_org_name_param
}

output "github_app_ssm_app_id_param" {
  description = "SSM parameter name holding the GitHub App's App ID."
  value       = module.github_app_secret.ssm_app_id_param
}

output "github_app_ssm_installation_id_param" {
  description = "SSM parameter name holding the GitHub App's installation ID in the org."
  value       = module.github_app_secret.ssm_installation_id_param
}
