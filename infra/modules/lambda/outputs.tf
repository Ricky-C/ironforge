output "function_name" {
  description = "Name of the Lambda function. Use as the target for API Gateway integration permission grants and CloudWatch metric/alarm targets."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN of the Lambda function. Use for explicit invocation grants from upstream services."
  value       = aws_lambda_function.this.arn
}

output "function_invoke_arn" {
  description = "Invoke ARN — the form API Gateway uses for Lambda integrations (`integration_uri` on aws_apigatewayv2_integration). Different from function_arn."
  value       = aws_lambda_function.this.invoke_arn
}

output "role_arn" {
  description = "ARN of the execution role. Useful for downstream resources that grant access to this Lambda specifically (e.g., a DynamoDB table whose access is gated on this role)."
  value       = aws_iam_role.execution.arn
}

output "role_name" {
  description = "Name of the execution role."
  value       = aws_iam_role.execution.name
}

output "log_group_name" {
  description = "Name of the CloudWatch log group receiving execution logs. Use for metric filter and alarm targets."
  value       = aws_cloudwatch_log_group.lambda.name
}

output "log_group_arn" {
  description = "ARN of the CloudWatch log group."
  value       = aws_cloudwatch_log_group.lambda.arn
}
