variable "environment" {
  description = "Deployment environment (dev or prod). Drives the state machine name and the log group path."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be one of: dev, prod."
  }
}

variable "task_lambda_arns" {
  description = "ARNs of every task Lambda the state machine invokes. Each key matches a state in the definition. Adding a state means adding both an entry here AND updating definition.json.tpl."
  type = object({
    validate_inputs     = string
    create_repo         = string
    generate_code       = string
    run_terraform       = string
    wait_for_cloudfront = string
    trigger_deploy      = string
    finalize            = string
    cleanup_on_failure  = string
  })
}

variable "log_retention_days" {
  description = "Retention for the state machine's CloudWatch log group. 14 days matches the Lambda module convention (CLAUDE.md operational defaults)."
  type        = number
  default     = 14
}
