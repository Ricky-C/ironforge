output "state_machine_arn" {
  description = "ARN of the provisioning state machine. The API Lambda's IAM role grants states:StartExecution on this ARN; POST /api/services calls StartExecution with executionName = jobId for natural idempotency."
  value       = aws_sfn_state_machine.provisioning.arn
}

output "state_machine_name" {
  description = "Name of the state machine (without ARN). For console deep-links and CLI invocations."
  value       = aws_sfn_state_machine.provisioning.name
}

output "role_arn" {
  description = "ARN of the IAM role the state machine assumes to invoke task Lambdas + write logs. Surfaced for diagnostic introspection."
  value       = aws_iam_role.state_machine.arn
}

output "log_group_arn" {
  description = "ARN of the CloudWatch log group receiving execution history. Operators query via CloudWatch Logs Insights for incident triage."
  value       = aws_cloudwatch_log_group.state_machine.arn
}

output "log_group_name" {
  description = "Name of the CloudWatch log group."
  value       = aws_cloudwatch_log_group.state_machine.name
}
