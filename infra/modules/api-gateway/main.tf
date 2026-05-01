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

  # CORS intentionally not configured. The architecture is BFF: Next.js
  # server (apps/web route handlers) calls this API; the browser never
  # hits API Gateway directly. Configuring CORS for non-existent
  # cross-origin callers invites silent expansion. Add CORS in a future
  # PR if a client-side fetch becomes a real requirement, with an
  # explicit allowed-origin list.

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
    # Throttling left at AWS account default (10000 RPS burst, 5000 RPS
    # steady). Tighten if traffic ever justifies a per-API limit.
  }

  tags = local.component_tags
}
