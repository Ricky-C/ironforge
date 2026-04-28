# AWS Budgets — two-tier protection.
#
# $30 alert budget: notifies on 50/80/100% actual and 100% forecast. No action.
# $50 deny budget: triggers an IAM policy attach action against designated principals.

resource "aws_budgets_budget" "alert_30" {
  name              = "ironforge-monthly-alert-30"
  budget_type       = "COST"
  limit_amount      = "30.0"
  limit_unit        = "USD"
  time_unit         = "MONTHLY"
  time_period_start = "2025-01-01_00:00"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }

  tags = local.component_tags
}

resource "aws_budgets_budget" "deny_50" {
  name              = "ironforge-monthly-action-50"
  budget_type       = "COST"
  limit_amount      = "50.0"
  limit_unit        = "USD"
  time_unit         = "MONTHLY"
  time_period_start = "2025-01-01_00:00"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  tags = local.component_tags
}

# Service role assumed by AWS Budgets when an action triggers.
# Created only when the action is enabled (at least one target principal).
#
# Confused-deputy mitigations (per ADR-002):
#   - aws:SourceAccount restricts to this account, so a misconfigured AWS
#     Budgets in another account cannot assume this role.
#   - aws:SourceArn restricts to our specific deny-50 budget, so even within
#     this account the role is assumable only for that budget's actions.
data "aws_iam_policy_document" "budget_action_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:budgets::${local.account_id}:budget/${aws_budgets_budget.deny_50.name}"]
    }
  }
}

resource "aws_iam_role" "budget_action" {
  count = local.budget_action_enabled ? 1 : 0

  name               = "ironforge-budget-action-executor"
  assume_role_policy = data.aws_iam_policy_document.budget_action_trust.json

  tags = local.component_tags
}

# AWS-managed policy purpose-built for Budgets actions. Acceptable per ADR-002:
# the role's trust policy restricts assumption to budgets.amazonaws.com with
# aws:SourceAccount and aws:SourceArn confused-deputy protections, so the broad
# iam:Attach*Policy permissions only apply during AWS-Budgets-initiated invocations
# on this account's specific deny-50 budget action.
resource "aws_iam_role_policy_attachment" "budget_action_managed" {
  count = local.budget_action_enabled ? 1 : 0

  role       = aws_iam_role.budget_action[0].name
  policy_arn = "arn:aws:iam::aws:policy/aws-service-role/AWSBudgetsActionsWithAWSResourceControlAccess"
}

resource "aws_budgets_budget_action" "deny_at_50" {
  count = local.budget_action_enabled ? 1 : 0

  budget_name        = aws_budgets_budget.deny_50.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budget_action[0].arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.deny_resource_creation.arn
      roles      = length(var.budget_action_target_roles) > 0 ? var.budget_action_target_roles : null
      users      = length(var.budget_action_target_users) > 0 ? var.budget_action_target_users : null
      groups     = length(var.budget_action_target_groups) > 0 ? var.budget_action_target_groups : null
    }
  }

  subscriber {
    address           = var.alert_email
    subscription_type = "EMAIL"
  }
}
