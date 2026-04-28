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

module "artifacts" {
  source = "../../modules/artifacts"
}

module "cognito" {
  source = "../../modules/cognito"

  clients = {
    dev = {
      callback_urls = ["http://localhost:3000/api/auth/callback/cognito"]
      logout_urls   = ["http://localhost:3000"]
    }
    prod = {
      callback_urls = ["https://ironforge.rickycaballero.com/api/auth/callback/cognito"]
      logout_urls   = ["https://ironforge.rickycaballero.com"]
    }
  }
}

module "dns" {
  source = "../../modules/dns"

  providers = {
    aws.us_east_1 = aws.us_east_1
  }

  domain_name = "ironforge.rickycaballero.com"
}
