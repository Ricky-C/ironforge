# SECURITY NOTE — Per-environment isolation is enforced at the API
# Gateway HTTP API JWT authorizer, with one application-layer check
# in Lambda for the failure mode the authorizer doesn't cover.
#
# This module creates ONE shared Cognito user pool with multiple app
# clients (one per env). Per ADR-005, the shared-resource default uses
# audience-claim verification for cryptographic env isolation. For
# Cognito ACCESS tokens, the audience-equivalent claim is `client_id`
# (the `aud` claim is present only on ID tokens).
#
# Token-type policy: the portal BFF MUST forward Cognito ACCESS tokens
# (not ID tokens) to API Gateway. With NextAuth/Auth.js this requires
# explicit JWT-callback wiring to expose `account.access_token` on the
# session.
#
# Verification split (per CLAUDE.md § Authentication):
#
# At API Gateway HTTP API JWT authorizer (each env has its own
# authorizer with its env-specific client_id as the configured
# Audience):
#   1. JWT signature against Cognito's JWKS endpoint
#   2. `iss` claim equals the user pool issuer URL
#   3. `aud` OR `client_id` claim matches the configured audience
#      (per AWS docs: "API Gateway validates client_id only if aud is
#      not present"). For access tokens this matches client_id; for ID
#      tokens it matches aud. CRITICAL for env isolation; see ADR-005.
#   4. `exp` claim hasn't passed
#
# At in-Lambda middleware (the one check the authorizer doesn't do):
#   5. `token_use` claim equals "access". The HTTP API JWT authorizer
#      does NOT enforce token_use — AWS docs explicitly note: "There
#      is no standard mechanism to differentiate JWT access tokens from
#      other types of JWTs, such as OpenID Connect ID tokens." Without
#      this in-Lambda check, an ID token from the same Cognito client
#      (same client_id, so it passes the authorizer's audience check)
#      would silently authenticate API calls — defeating the BFF's
#      access-tokens-only policy above.
#
# The middleware also Zod-validates the claims object shape as defense
# in depth against a malformed authorizer-injected payload, and
# attaches the typed user to the Hono context for handlers.

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
