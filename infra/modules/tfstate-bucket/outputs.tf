output "bucket_name" {
  description = "Name of the per-env terraform state bucket. Workflow Lambdas configure terraform's S3 backend to point here."
  value       = aws_s3_bucket.tfstate.bucket
}

output "bucket_arn" {
  description = "ARN of the per-env terraform state bucket. Consuming Lambda IAM grants for s3:GetObject/s3:PutObject scope to this ARN."
  value       = aws_s3_bucket.tfstate.arn
}

output "kms_key_arn" {
  description = "ARN of the CMK encrypting per-env terraform state. Consuming Lambda IAM grants for kms:Decrypt + kms:GenerateDataKey scope to this ARN."
  value       = aws_kms_key.tfstate.arn
}

output "kms_key_alias" {
  description = "Alias of the per-env terraform state CMK (alias/ironforge-tfstate-<env>)."
  value       = aws_kms_alias.tfstate.name
}
