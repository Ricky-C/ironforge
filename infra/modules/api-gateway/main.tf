# Per-env Ironforge API Gateway HTTP API. Per ADR-005's shared-resource
# default with topology-driven exceptions: HTTP API JWT authorizer's
# `Audience` is env-specific (the env's Cognito client_id) and the
# authorizer binds at the API level (no stage-variable substitution in
# JwtConfiguration.Audience), so per-env audiences require per-env APIs.
#
# Verification split (CLAUDE.md § Authentication):
#   - This authorizer verifies signature, iss, audience (client_id), exp.
#   - In-Lambda middleware (services/api/src/middleware/auth.ts) verifies
#     token_use === "access" — the one check the authorizer cannot.
#
# Custom domain (api.ironforge.rickycaballero.com) is intentionally
# deferred to a follow-up PR; this module exposes the default
# execute-api URL via api_endpoint.

data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  log_group_name = "/aws/apigateway/${var.api_name}"

  component_tags = {
    "ironforge-component"   = "api-gateway"
    "ironforge-environment" = var.environment
  }

  # HTTP API access log fields. Per AWS docs (verified 2026-05-01),
  # HTTP API uses namespaced integration fields ($context.integration.*),
  # not REST API's flat names. routeKey is HTTP API-specific and gives
  # routing visibility independent of path templating.
  access_log_format = jsonencode({
    requestId          = "$context.requestId"
    ip                 = "$context.identity.sourceIp"
    userAgent          = "$context.identity.userAgent"
    requestTime        = "$context.requestTime"
    httpMethod         = "$context.httpMethod"
    routeKey           = "$context.routeKey"
    path               = "$context.path"
    status             = "$context.status"
    responseLength     = "$context.responseLength"
    integrationStatus  = "$context.integration.status"
    integrationLatency = "$context.integration.latency"
    integrationError   = "$context.integration.error"
    responseLatency    = "$context.responseLatency"
  })
}

# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "this" {
  name          = var.api_name
  protocol_type = "HTTP"
  description   = "Ironforge ${var.environment} API. JWT-authorized; integrates with Lambda. See docs/data-model.md for the access-pattern catalog."

  # CORS opt-in via var.cors_allowed_origins. Empty list (the default)
  # emits no cors_configuration block — preserves the historical
  # BFF-only posture. Subphase 2.5's portal (oidc-client-ts) calls this
  # API directly from the browser; per-env compositions opt in by
  # passing the SPA origin.
  #
  # Methods / headers / credentials are derived from what THIS API
  # serves (CRUD on /api/services with Bearer auth + Idempotency-Key on
  # POST). Hardcoded here, not per-env, because they're API-surface
  # facts, not deployment policy. Updating them as new endpoints land
  # is a deliberate audit moment.
  dynamic "cors_configuration" {
    for_each = length(var.cors_allowed_origins) > 0 ? [1] : []
    content {
      allow_origins  = var.cors_allowed_origins
      allow_methods  = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
      allow_headers  = ["Authorization", "Content-Type", "Idempotency-Key"]
      expose_headers = []
      # No cookie / credentialed auth — Bearer in Authorization only.
      # Keeps the CORS surface tight (allow_credentials=true would
      # require named origins anyway, but explicit is better).
      allow_credentials = false
      # 600s preflight cache; reduces OPTIONS chatter without making
      # CORS-policy changes feel slow to surface in dev.
      max_age = 600
    }
  }

  tags = local.component_tags
}

# ---------------------------------------------------------------------------
# JWT authorizer — env-specific Cognito audience
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_authorizer" "cognito_jwt" {
  api_id           = aws_apigatewayv2_api.this.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.api_name}-cognito-jwt"

  jwt_configuration {
    issuer = var.jwt_issuer
    # AWS docs: when `aud` is absent on the token (Cognito access tokens),
    # API Gateway validates `client_id` against this Audience list. So
    # registering the env's client_id here gates dev tokens out of prod
    # APIs and vice-versa.
    audience = [var.jwt_audience]
  }
}

# ---------------------------------------------------------------------------
# Lambda integration + catch-all route protected by the JWT authorizer
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.lambda_invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# $default route catches every method/path not explicitly routed. With a
# single Lambda integration that does its own Hono routing, $default is
# the right shape — Hono returns 404 for paths it doesn't register.
resource "aws_apigatewayv2_route" "default" {
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "$default"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# Public demo routes for subphase 2.6. API Gateway HTTP API route
# specificity puts `ANY /api/demo/{proxy+}` ahead of `$default`, so
# requests under /api/demo/* match THIS route (with NONE auth) instead
# of the JWT-authorized $default. Lambda receives them with no
# authorizer claims; the in-Lambda middleware skips auth for paths
# starting with `/api/demo/` (trailing slash — see handler.ts).
#
# Critical design property: a stale Bearer token in localStorage from
# a prior authenticated session does NOT cause 401 on demo paths,
# because route-level NONE wins over the gateway authorizer. A
# regression here (e.g., authorizer applied universally) would break
# demo for users with authenticated history. PR's verification plan
# includes an explicit curl with an invalid Bearer to catch this.
resource "aws_apigatewayv2_route" "demo_public" {
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "ANY /api/demo/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

# Permission for API Gateway to invoke the Lambda. Source ARN scoped to
# this specific API + any stage + any route key.
resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# Stage with access logging + detailed metrics + tracing
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "access" {
  name              = local.log_group_name
  retention_in_days = var.access_log_retention_days

  # AWS-managed encryption per ADR-003. Access logs do not contain the
  # request/response payload — only routing + identity metadata — so the
  # CMK threshold is not met.

  tags = local.component_tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format          = local.access_log_format
  }

  default_route_settings {
    detailed_metrics_enabled = var.enable_detailed_metrics

    # HTTP API (v2) requires explicit throttling values. Unset values are
    # serialized by the AWS provider as 0, which AWS interprets as "stage
    # blocked" (every request 429s) — NOT "inherit account default" as the
    # REST-API mental model would suggest. The dev posture is generous
    # enough to never feel during use, restrictive enough to bound abuse;
    # prod values are tracked as tech debt pending real traffic patterns.
    # See docs/tech-debt.md § "Production API Gateway throttling values
    # are placeholder".
    throttling_burst_limit = var.throttling_burst_limit
    throttling_rate_limit  = var.throttling_rate_limit
  }

  tags = local.component_tags
}
