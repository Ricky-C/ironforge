variable "environment" {
  description = "Deployment environment (dev or prod). Drives state machine names and log group paths."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be one of: dev, prod."
  }
}

# Per-state-machine ARN bundles. Typed objects (rather than a flat
# map[string]string) catch "forgot to wire a Lambda" at terraform plan
# time — any missing key surfaces as a plan-time validation error
# instead of a runtime States.TaskFailed. Each key matches a state
# referenced by ${...} in the corresponding *.json.tpl.
#
# `run_terraform` appears in both bundles: the deprovisioning state
# machine reuses the same Lambda with action="destroy" supplied via
# Parameters injection (see deprovision-definition.json.tpl). Callers
# pass the same ARN to both keys.

variable "provisioning_lambda_arns" {
  description = "ARNs of every task Lambda invoked by the provisioning state machine. Adding a state to provision-definition.json.tpl requires adding the matching key here."
  type = object({
    validate_inputs     = string
    create_repo         = string
    generate_code       = string
    run_terraform       = string
    wait_for_cloudfront = string
    trigger_deploy      = string
    wait_for_deploy     = string
    finalize            = string
    cleanup_on_failure  = string
  })
}

variable "deprovisioning_lambda_arns" {
  description = "ARNs of Lambdas invoked by the deprovisioning state machine. run_terraform is reused from provisioning (action=\"destroy\" is injected at the SFN Parameters layer)."
  type = object({
    run_terraform             = string
    delete_external_resources = string
    deprovision_failed        = string
  })
}

variable "log_retention_days" {
  description = "Retention for the state machine CloudWatch log groups. 14 days matches the Lambda module convention (CLAUDE.md operational defaults)."
  type        = number
  default     = 14
}
