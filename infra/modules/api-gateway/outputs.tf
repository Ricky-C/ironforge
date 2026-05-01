output "api_id" {
  description = "ID of the HTTP API. Useful for downstream resources that need to reference this API specifically."
  value       = aws_apigatewayv2_api.this.id
}

output "api_arn" {
  description = "ARN of the HTTP API. Use for IAM resource scoping (e.g., a future custom domain mapping or a WAF association)."
  value       = aws_apigatewayv2_api.this.arn
}

output "api_endpoint" {
  description = "Default execute-api URL for the API (e.g., https://abc123.execute-api.us-east-1.amazonaws.com). Custom domain support is intentionally deferred — when added, this output is replaced or supplemented by `custom_domain_url`. Next.js apps consume this via the NEXT_PUBLIC_IRONFORGE_API_URL env var."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "stage_name" {
  description = "Name of the stage (always `$default` for HTTP API auto-deploy)."
  value       = aws_apigatewayv2_stage.default.name
}

output "access_log_group_name" {
  description = "Name of the CloudWatch log group receiving access logs. Use for Logs Insights queries and metric filter targets."
  value       = aws_cloudwatch_log_group.access.name
}

output "access_log_group_arn" {
  description = "ARN of the access log group."
  value       = aws_cloudwatch_log_group.access.arn
}

output "authorizer_id" {
  description = "ID of the JWT authorizer. Useful when adding additional routes that should share the same authorizer config."
  value       = aws_apigatewayv2_authorizer.cognito_jwt.id
}
