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
