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

variable "portal_waf_enabled" {
  description = "Whether the portal CloudFront WAF web ACL EXISTS. Default false to avoid the ~$9/mo standing charge (1 web ACL + 4 rules) on a portfolio project that is dormant most of the time — the WAF is edge defense-in-depth, not the provisioning gate (Cognito + the concurrency cap do that), and the portal Lambda's reserved concurrency replaces its flood-cost-protection role for $0. Toggle ON = one apply (ACL created + attached). Toggle OFF = two applies (set portal_waf_attached=false first, then this false) because AWS won't delete an associated ACL. See ADR-012 § Toggling off."
  type        = bool
  default     = false
}

variable "portal_waf_attached" {
  description = "Whether the (existing) portal WAF ACL is attached to the CloudFront distribution. Decoupled from portal_waf_enabled so toggle-OFF is safe in two applies: set this false + apply (detach, ACL survives), wait for CloudFront to propagate, then set portal_waf_enabled false + apply (delete the now-detached ACL). Default true: when the ACL exists it should normally be attached. Ignored when portal_waf_enabled is false. See ADR-012 § Toggling off."
  type        = bool
  default     = true
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
