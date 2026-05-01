output "secret_arn" {
  description = "ARN of the GitHub App private key Secrets Manager entry. Consumers MUST scope `secretsmanager:GetSecretValue` IAM grants to this exact ARN, never a wildcard."
  value       = aws_secretsmanager_secret.github_app_private_key.arn
}

output "secret_name" {
  description = "Name of the GitHub App private key Secrets Manager entry. Used by runtime callers calling `GetSecretValue`."
  value       = aws_secretsmanager_secret.github_app_private_key.name
}

output "kms_key_arn" {
  description = "ARN of the CMK encrypting the GitHub App private key. Tier 1 per ADR-003 — single-resource scope. Consumers MUST scope `kms:Decrypt` grants to this ARN AND condition on `kms:EncryptionContext:SecretARN` matching `secret_arn`."
  value       = aws_kms_key.github_app.arn
}

output "kms_key_alias" {
  description = "Alias of the GitHub App private key CMK (alias/ironforge-github-app-private-key). Used by the bootstrap procedure's aws secretsmanager create-secret call."
  value       = aws_kms_alias.github_app.name
}

output "ssm_parameter_path" {
  description = "Path prefix for tenant-specific GitHub App identifiers in SSM Parameter Store (/ironforge/github-app). IAM scoping for consumers should target the ssm parameter ARN with this path appended."
  value       = "/ironforge/github-app"
}

output "ssm_org_name_param" {
  description = "SSM parameter name holding the GitHub org name."
  value       = aws_ssm_parameter.org_name.name
}

output "ssm_app_id_param" {
  description = "SSM parameter name holding the GitHub App ID."
  value       = aws_ssm_parameter.app_id.name
}

output "ssm_installation_id_param" {
  description = "SSM parameter name holding the GitHub App's installation ID in the org."
  value       = aws_ssm_parameter.installation_id.name
}
