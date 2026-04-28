output "sns_topic_arn" {
  description = "ARN of the cost-alerts SNS topic. Consumed by the daily cost reporter Lambda."
  value       = aws_sns_topic.cost_alerts.arn
}

output "deny_policy_arn" {
  description = "ARN of the deny IAM policy attached by the budget action. Useful for manual attach during testing or out-of-band recovery."
  value       = aws_iam_policy.deny_resource_creation.arn
}

output "budget_alert_30_name" {
  description = "Name of the $30 alert budget."
  value       = aws_budgets_budget.alert_30.name
}

output "budget_deny_50_name" {
  description = "Name of the $50 deny-action budget."
  value       = aws_budgets_budget.deny_50.name
}

output "anomaly_monitor_arn" {
  description = "ARN of the cost anomaly monitor."
  value       = aws_ce_anomaly_monitor.all_services.arn
}

output "budget_action_executor_role_arn" {
  description = "ARN of the IAM role assumed by AWS Budgets when the $50 action triggers. Null when the action is disabled (no target principals)."
  value       = local.budget_action_enabled ? aws_iam_role.budget_action[0].arn : null
}

output "cost_reporter_function_name" {
  description = "Name of the daily cost reporter Lambda function."
  value       = aws_lambda_function.cost_reporter.function_name
}

output "cost_reporter_function_arn" {
  description = "ARN of the daily cost reporter Lambda function."
  value       = aws_lambda_function.cost_reporter.arn
}

output "cost_reporter_log_group_name" {
  description = "CloudWatch log group name for the cost reporter Lambda."
  value       = aws_cloudwatch_log_group.cost_reporter.name
}
