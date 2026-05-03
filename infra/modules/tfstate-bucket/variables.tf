variable "environment" {
  description = "Deployment environment (dev or prod). Drives the bucket name suffix and the ironforge-environment tag."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be one of: dev, prod."
  }
}

variable "consuming_lambda_role_arns" {
  description = <<-EOT
    Role ARNs of the workflow Lambdas that read/write per-service terraform state. Each ARN listed here is added as a principal in the CMK key policy's `AllowConsumingLambdaUseKey` statement.

    Default `[]` so this module can apply standalone before any consuming Lambda role exists. PR-C.6 adds run-terraform's role ARN; future destroy-chain work (cleanup-on-failure real impl) may add more.

    Same forward-referenceable shape as `infra/modules/github-app-secret/variables.tf`'s `workflow_lambda_role_arns`. AWS IAM accepts non-existent role ARNs in key policies; this module can apply BEFORE the consuming Lambda's composition applies.
  EOT
  type        = list(string)
  default     = []
}
