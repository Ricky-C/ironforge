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
