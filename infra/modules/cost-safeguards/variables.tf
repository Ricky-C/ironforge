variable "alert_email" {
  description = "Email address to receive cost alerts, anomaly notifications, and daily cost reports."
  type        = string
}

variable "budget_action_target_roles" {
  description = "IAM role names that receive the deny policy when the $50 budget action triggers."
  type        = list(string)
  default     = []
}

variable "budget_action_target_users" {
  description = "IAM user names that receive the deny policy when the $50 budget action triggers."
  type        = list(string)
  default     = []
}

variable "budget_action_target_groups" {
  description = "IAM group names that receive the deny policy when the $50 budget action triggers."
  type        = list(string)
  default     = []
}
