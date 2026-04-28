output "table_name" {
  description = "Name of the Ironforge DynamoDB table."
  value       = aws_dynamodb_table.ironforge.name
}

output "table_arn" {
  description = "ARN of the Ironforge DynamoDB table."
  value       = aws_dynamodb_table.ironforge.arn
}

output "table_stream_arn" {
  description = "Stream ARN if streams are enabled (null when disabled). Reserved for future use."
  value       = aws_dynamodb_table.ironforge.stream_arn
}

output "kms_key_arn" {
  description = "ARN of the KMS key encrypting the table. Scope IAM policies to this ARN, not kms:* on *."
  value       = aws_kms_key.this.arn
}

output "kms_key_id" {
  description = "ID of the KMS key encrypting the table."
  value       = aws_kms_key.this.key_id
}
