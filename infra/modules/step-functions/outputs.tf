output "provisioning_state_machine_arn" {
  description = "ARN of the provisioning state machine. The API Lambda's IAM role grants states:StartExecution on this ARN; POST /api/services calls StartExecution with executionName = jobId for natural idempotency."
  value       = aws_sfn_state_machine.provisioning.arn
}

output "provisioning_state_machine_name" {
  description = "Name of the provisioning state machine (without ARN). For console deep-links and CLI invocations."
  value       = aws_sfn_state_machine.provisioning.name
}

output "deprovisioning_state_machine_arn" {
  description = "ARN of the deprovisioning state machine (Phase 1.5). DELETE /api/services/:id calls StartExecution on this ARN with executionName = jobId; the API Lambda's IAM grant + env var land in PR 5."
  value       = aws_sfn_state_machine.deprovisioning.arn
}

output "deprovisioning_state_machine_name" {
  description = "Name of the deprovisioning state machine. Naming convention (ironforge-<env>-deprovisioning) is the contract PR 5's API composition uses to construct the ARN locally without needing this output."
  value       = aws_sfn_state_machine.deprovisioning.name
}

output "role_arn" {
  description = "ARN of the IAM role both state machines assume to invoke task Lambdas + write logs. Surfaced for diagnostic introspection."
  value       = aws_iam_role.state_machine.arn
}

output "provisioning_log_group_arn" {
  description = "ARN of the CloudWatch log group receiving provisioning execution history."
  value       = aws_cloudwatch_log_group.provisioning.arn
}

output "provisioning_log_group_name" {
  description = "Name of the provisioning execution log group."
  value       = aws_cloudwatch_log_group.provisioning.name
}

output "deprovisioning_log_group_arn" {
  description = "ARN of the CloudWatch log group receiving deprovisioning execution history."
  value       = aws_cloudwatch_log_group.deprovisioning.arn
}

output "deprovisioning_log_group_name" {
  description = "Name of the deprovisioning execution log group."
  value       = aws_cloudwatch_log_group.deprovisioning.name
}
