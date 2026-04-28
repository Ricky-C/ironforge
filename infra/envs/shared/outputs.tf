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
