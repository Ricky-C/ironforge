variable "alert_email" {
  description = "Email address to receive cost alerts, anomaly notifications, and the daily cost report. Real value belongs in gitignored terraform.tfvars."
  type        = string

  validation {
    condition     = can(regex("^[^@]+@[^@]+\\.[^@]+$", var.alert_email))
    error_message = "alert_email must be a valid email address."
  }
}

variable "budget_action_target_roles" {
  description = "IAM role names that receive the deny policy when the $50 budget action triggers. Empty list disables the action."
  type        = list(string)
  default     = []
}

variable "budget_action_target_users" {
  description = "IAM user names that receive the deny policy when the $50 budget action triggers. Empty list disables the action."
  type        = list(string)
  default     = []
}

variable "budget_action_target_groups" {
  description = "IAM group names that receive the deny policy when the $50 budget action triggers. Empty list disables the action."
  type        = list(string)
  default     = []
}

variable "github_org_name" {
  description = "GitHub organization that holds Ironforge-provisioned repos (e.g., ironforge-svc). Tenant-specific — supply via gitignored terraform.tfvars per the env-specific-identifiers convention."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]*$", var.github_org_name)) && length(var.github_org_name) <= 39
    error_message = "github_org_name must match GitHub's org-name rules: alphanumeric and hyphens only, must start with alphanumeric, max 39 chars."
  }
}

variable "github_app_id" {
  description = "GitHub App's numeric App ID. Tenant-specific — supply via gitignored terraform.tfvars."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_app_id))
    error_message = "github_app_id must be numeric."
  }
}

variable "github_app_installation_id" {
  description = "Installation ID of the Ironforge GitHub App in the org. Tenant-specific — supply via gitignored terraform.tfvars."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_app_installation_id))
    error_message = "github_app_installation_id must be numeric."
  }
}
