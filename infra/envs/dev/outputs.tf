output "api_url" {
  description = "Default execute-api URL for the dev API. Apps consume this via NEXT_PUBLIC_IRONFORGE_API_URL or equivalent. Custom domain support is deferred — when added, this output is replaced by the custom domain URL and the eventual swap is config-only on the consumer side."
  value       = module.api_gateway.api_endpoint
}

output "api_id" {
  description = "ID of the dev API Gateway HTTP API. Useful for ad-hoc CLI inspection (`aws apigatewayv2 get-api --api-id <id>`)."
  value       = module.api_gateway.api_id
}

output "api_lambda_function_name" {
  description = "Name of the dev API Lambda. Useful for log tailing (`aws logs tail /aws/lambda/<name>`) and ad-hoc invocation."
  value       = module.api_lambda.function_name
}

output "dynamodb_table_name" {
  description = "Name of the dev DynamoDB table. Surfaced for ad-hoc CLI inspection; production code reads this via the Lambda env var (DYNAMODB_TABLE_NAME)."
  value       = module.dynamodb.table_name
}
