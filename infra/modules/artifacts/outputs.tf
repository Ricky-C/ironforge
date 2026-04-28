output "bucket_name" {
  description = "Name of the shared artifacts bucket. Per-env content lives under dev/ and prod/ key prefixes."
  value       = aws_s3_bucket.artifacts.bucket
}

output "bucket_arn" {
  description = "ARN of the shared artifacts bucket. Consumers must scope IAM grants to env prefixes (e.g., <bucket_arn>/dev/*); never grant on the whole bucket."
  value       = aws_s3_bucket.artifacts.arn
}

output "bucket_regional_domain_name" {
  description = "Regional domain name of the bucket."
  value       = aws_s3_bucket.artifacts.bucket_regional_domain_name
}
