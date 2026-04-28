output "user_pool_id" {
  description = "ID of the shared Cognito user pool."
  value       = aws_cognito_user_pool.ironforge.id
}

output "user_pool_arn" {
  description = "ARN of the shared Cognito user pool."
  value       = aws_cognito_user_pool.ironforge.arn
}

output "user_pool_domain" {
  description = "Domain prefix of the user pool. The full URL is https://<domain>.auth.<region>.amazoncognito.com — consumers can construct the full URL via issuer_url for OIDC discovery."
  value       = aws_cognito_user_pool_domain.ironforge.domain
}

output "issuer_url" {
  description = "OIDC issuer URL for the user pool. Used by JWT verifiers (NextAuth etc.) for token signature validation via the JWKS endpoint at <issuer_url>/.well-known/jwks.json."
  value       = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.ironforge.id}"
}

output "client_ids" {
  description = "Map of env name to user pool client ID. The app for each env MUST verify the JWT aud claim matches its client_id — see SECURITY NOTE in main.tf."
  value       = { for k, v in aws_cognito_user_pool_client.this : k => v.id }
}
