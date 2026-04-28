# Shared (account-level) composition root.
# Resources here apply once per AWS account, not per env.
# See docs/adrs/001-shared-env-composition.md for the rationale.

module "cost_safeguards" {
  source = "../../modules/cost-safeguards"

  alert_email                 = var.alert_email
  budget_action_target_roles  = var.budget_action_target_roles
  budget_action_target_users  = var.budget_action_target_users
  budget_action_target_groups = var.budget_action_target_groups
}
