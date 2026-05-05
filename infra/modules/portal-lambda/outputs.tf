output "ecr_repository_url" {
  description = "ECR registry URI for the portal Lambda image (e.g., 010438464240.dkr.ecr.us-east-1.amazonaws.com/ironforge-portal). PR-B's image-build script consumes this for `docker push`; PR-B's Lambda terraform consumes the resolved digest URI from a build artifact."
  value       = aws_ecr_repository.portal.repository_url
}

output "ecr_repository_arn" {
  description = "ECR repository ARN, for IAM scoping at consumer call sites if needed beyond the existing WriteIronforgeECR pattern."
  value       = aws_ecr_repository.portal.arn
}

output "ecr_repository_name" {
  description = "ECR repository name (no registry prefix). Used by image-build scripts and IAM resource ARN construction."
  value       = aws_ecr_repository.portal.name
}

output "lambda_role_arn" {
  description = "Portal Lambda execution role ARN. PR-B's aws_lambda_function consumes this as `role`."
  value       = aws_iam_role.portal.arn
}

output "lambda_role_name" {
  description = "Portal Lambda execution role name (without ARN prefix). Useful for additional inline-policy attachments downstream."
  value       = aws_iam_role.portal.name
}

output "lambda_function_name" {
  description = "Expected portal Lambda function name. PR-B's aws_lambda_function MUST set function_name to this value so the explicitly-created CloudWatch log group is the destination Lambda writes to (Lambda auto-creates a log group with the function name on first invocation if a matching one doesn't exist; using this output prevents the auto-create from racing the explicit one)."
  value       = local.function_name
}

output "log_group_name" {
  description = "CloudWatch log group name for the portal Lambda. Pre-created with 14-day retention."
  value       = aws_cloudwatch_log_group.portal.name
}

output "log_group_arn" {
  description = "CloudWatch log group ARN."
  value       = aws_cloudwatch_log_group.portal.arn
}
