variable "org_name" {
  description = "GitHub organization name that holds Ironforge-provisioned repos (e.g., ironforge-svc). Tenant-specific — supply via gitignored terraform.tfvars per the env-specific-identifiers convention."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]*$", var.org_name)) && length(var.org_name) <= 39
    error_message = "org_name must match GitHub's org-name rules: alphanumeric and hyphens only, must start with alphanumeric, max 39 chars."
  }
}

variable "app_id" {
  description = "GitHub App's numeric App ID. Tenant-specific — supply via gitignored terraform.tfvars."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.app_id))
    error_message = "app_id must be numeric (GitHub App IDs are integers, stored as strings here so leading-zero correctness can't be a future surprise)."
  }
}

variable "installation_id" {
  description = "Installation ID of the GitHub App in the org. Tenant-specific — supply via gitignored terraform.tfvars."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.installation_id))
    error_message = "installation_id must be numeric."
  }
}

variable "workflow_lambda_role_arns" {
  description = <<-EOT
    Role ARNs of the workflow Lambdas that mint GitHub App installation tokens. Each ARN listed here is added as a principal in the CMK key policy's `AllowWorkflowLambdaDecrypt` statement, gated on the `kms:EncryptionContext:SecretARN` matching this module's secret ARN exactly.

    Default `[]` so this module can apply standalone (PR #41 era — no consumers yet). PR-C.4b adds the create-repo Lambda role ARN; PR-C.8 will append the trigger-deploy Lambda role ARN. Order does not matter; AWS re-serializes the principals list.

    Role ARNs are forward-referenceable: AWS IAM accepts a role ARN in a key policy even if the role does not yet exist. This module can apply BEFORE the consuming Lambda's composition applies — first invocation succeeds as long as the key policy is in place by then.
  EOT
  type        = list(string)
  default     = []
}
