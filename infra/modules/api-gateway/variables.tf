variable "api_name" {
  description = "API Gateway HTTP API name. MUST start with `ironforge-`. Per-env APIs should follow `ironforge-<env>-api` (e.g., `ironforge-dev-api`) — same naming as the Lambda for traceability."
  type        = string

  validation {
    condition     = startswith(var.api_name, "ironforge-")
    error_message = "api_name must start with `ironforge-` per the AWS resource naming convention."
  }
}

variable "environment" {
  description = "Deployment environment. Drives the `ironforge-environment` tag and the stage name."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be one of: dev, prod."
  }
}

variable "jwt_issuer" {
  description = "OIDC issuer URL for the JWT authorizer. Pulled from the shared composition's Cognito module — `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>`. Same value across envs because the user pool is shared (per ADR-005's audience-claim isolation pattern)."
  type        = string
}

variable "jwt_audience" {
  description = "Env-specific Cognito user-pool client_id, registered as the JWT authorizer's `Audience`. The HTTP API JWT authorizer treats Cognito access tokens (no `aud`, has `client_id`) as matching `Audience` against `client_id` per AWS docs. See infra/modules/cognito/main.tf SECURITY NOTE."
  type        = string
}

variable "lambda_invoke_arn" {
  description = "Invoke ARN of the integration Lambda (the `function_invoke_arn` output from the lambda module). Different from the function ARN; do not confuse."
  type        = string
}

variable "lambda_function_name" {
  description = "Name of the integration Lambda. Used for the lambda:InvokeFunction permission grant from API Gateway."
  type        = string
}

variable "access_log_retention_days" {
  description = "CloudWatch log group retention for API Gateway access logs. 7 days is the cost-leaning default for high-volume edge logs (Lambda execution logs default to 14d — asymmetric retention reflects asymmetric volumes)."
  type        = number
  default     = 7
}

variable "enable_detailed_metrics" {
  description = "Enable per-route detailed metrics on the stage. Useful for per-endpoint latency/error visibility but doubles CloudWatch metric volume — disable if metric cost becomes a concern."
  type        = bool
  default     = true
}

variable "throttling_burst_limit" {
  description = "API Gateway HTTP API stage burst limit (max concurrent requests). MUST be > 0; 0 blocks all traffic on HTTP API v2 (unlike REST API where 0 inherits account default). Dev default 50 is generous for a single user, restrictive for abuse."
  type        = number
  default     = 50

  validation {
    condition     = var.throttling_burst_limit > 0
    error_message = "throttling_burst_limit must be > 0; setting to 0 blocks all stage traffic on HTTP API v2."
  }
}

variable "throttling_rate_limit" {
  description = "API Gateway HTTP API stage steady-state rate limit (requests per second). MUST be > 0; 0 blocks all traffic on HTTP API v2. Dev default 20 RPS sustains a single user comfortably."
  type        = number
  default     = 20

  validation {
    condition     = var.throttling_rate_limit > 0
    error_message = "throttling_rate_limit must be > 0; setting to 0 blocks all stage traffic on HTTP API v2."
  }
}
