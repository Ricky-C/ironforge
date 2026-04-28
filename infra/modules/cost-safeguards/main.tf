# Cost safeguards module composition.
#
# Resource definitions are split across budgets.tf, anomaly.tf, sns.tf, iam.tf
# for readability. This file holds shared locals only.

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  component_tags = {
    "ironforge-component" = "cost-safeguards"
  }

  # Budget action triggers iff at least one principal is targeted.
  # When all three target lists are empty the action resource is omitted.
  budget_action_enabled = (
    length(var.budget_action_target_roles) +
    length(var.budget_action_target_users) +
    length(var.budget_action_target_groups)
  ) > 0
}
