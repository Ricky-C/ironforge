output "trail_arn" {
  description = "ARN of the CloudTrail trail. Phase 1 metric-filter modules consume this via terraform_remote_state."
  value       = aws_cloudtrail.main.arn
}

output "trail_name" {
  description = "Name of the CloudTrail trail."
  value       = aws_cloudtrail.main.name
}

output "bucket_name" {
  description = "Name of the S3 bucket holding CloudTrail logs."
  value       = aws_s3_bucket.logs.bucket
}

output "bucket_arn" {
  description = "ARN of the S3 bucket holding CloudTrail logs."
  value       = aws_s3_bucket.logs.arn
}

output "kms_key_arn" {
  description = "ARN of the CMK encrypting both the log bucket and the CloudWatch log group. Consumers MUST scope grants via the appropriate kms:EncryptionContext condition (aws:cloudtrail:arn for trail-side use, aws:logs:arn for log-group-side use)."
  value       = aws_kms_key.cloudtrail.arn
}

output "log_group_name" {
  description = "Name of the CloudWatch log group receiving CloudTrail events. Phase 1 metric filters target this group."
  value       = aws_cloudwatch_log_group.cloudtrail.name
}

output "log_group_arn" {
  description = "ARN of the CloudWatch log group receiving CloudTrail events."
  value       = aws_cloudwatch_log_group.cloudtrail.arn
}
