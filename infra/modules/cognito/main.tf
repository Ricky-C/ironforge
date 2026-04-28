# SECURITY NOTE — Per-environment isolation depends on application-layer
# JWT audience verification.
#
# This module creates ONE shared Cognito user pool with multiple app
# clients (one per env). Tokens issued by Cognito carry an `aud` claim
# naming the client_id that requested them. The Next.js app's JWT
# verifier MUST validate `aud` matches the expected client ID for the
# env it's serving — without this check, a token issued via the dev
# client will authenticate against the prod app.
#
# When the auth middleware lands (Phase 1), confirm:
#   1. JWT signature verified against Cognito's JWKS endpoint
#   2. `aud` claim equals the env's expected client_id (CRITICAL)
#   3. `iss` claim equals the user pool issuer URL
#   4. `token_use` claim is "access" or "id" as expected
#   5. `exp` claim hasn't passed
#
# If `aud` verification is skipped or buggy, env isolation is broken.
# This is the trade-off accepted in exchange for a single shared pool.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  pool_name = "ironforge"
  domain    = "ironforge-${data.aws_caller_identity.current.account_id}"

  component_tags = {
    "ironforge-component" = "auth"
  }
}

resource "aws_cognito_user_pool" "ironforge" {
  name = local.pool_name

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 12
    require_uppercase                = true
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  # MFA off for MVP; advanced security ("Cognito Plus") off to avoid the
  # per-MAU surcharge. Both can be enabled later if abuse appears.
  mfa_configuration = "OFF"

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  tags = merge(local.component_tags, {
    Name = local.pool_name
  })
}

resource "aws_cognito_user_pool_domain" "ironforge" {
  domain       = local.domain
  user_pool_id = aws_cognito_user_pool.ironforge.id
}

resource "aws_cognito_user_pool_client" "this" {
  for_each = var.clients

  name         = "ironforge-portal-${each.key}"
  user_pool_id = aws_cognito_user_pool.ironforge.id

  # Public client (PKCE flow). No client secret stored anywhere.
  generate_secret = false

  callback_urls = each.value.callback_urls
  logout_urls   = each.value.logout_urls

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  supported_identity_providers         = ["COGNITO"]

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # 30-minute access/id tokens — security-conscious; refresh cost is trivial.
  # 30-day refresh window covers typical user sessions.
  access_token_validity  = 30
  id_token_validity      = 30
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # Generic auth-failed errors to avoid revealing whether a username exists.
  prevent_user_existence_errors = "ENABLED"

  # Allow signing-out a refresh token before its natural expiration.
  enable_token_revocation = true
}
