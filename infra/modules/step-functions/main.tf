locals {
  provisioning_state_machine_name   = "ironforge-${var.environment}-provisioning"
  deprovisioning_state_machine_name = "ironforge-${var.environment}-deprovisioning"

  component_tags_provisioning = {
    "ironforge-component"   = "step-functions"
    "ironforge-environment" = var.environment
    Name                    = local.provisioning_state_machine_name
  }

  component_tags_deprovisioning = {
    "ironforge-component"   = "step-functions"
    "ironforge-environment" = var.environment
    Name                    = local.deprovisioning_state_machine_name
  }

  provisioning_definition = templatefile("${path.module}/provision-definition.json.tpl", {
    validate_inputs_arn     = var.provisioning_lambda_arns.validate_inputs
    create_repo_arn         = var.provisioning_lambda_arns.create_repo
    generate_code_arn       = var.provisioning_lambda_arns.generate_code
    run_terraform_arn       = var.provisioning_lambda_arns.run_terraform
    wait_for_cloudfront_arn = var.provisioning_lambda_arns.wait_for_cloudfront
    trigger_deploy_arn      = var.provisioning_lambda_arns.trigger_deploy
    wait_for_deploy_arn     = var.provisioning_lambda_arns.wait_for_deploy
    finalize_arn            = var.provisioning_lambda_arns.finalize
    cleanup_on_failure_arn  = var.provisioning_lambda_arns.cleanup_on_failure
  })

  deprovisioning_definition = templatefile("${path.module}/deprovision-definition.json.tpl", {
    run_terraform_arn             = var.deprovisioning_lambda_arns.run_terraform
    delete_external_resources_arn = var.deprovisioning_lambda_arns.delete_external_resources
    deprovision_failed_arn        = var.deprovisioning_lambda_arns.deprovision_failed
  })

  # Union of unique Lambda ARNs across both state machines, for the
  # shared SFN role's lambda:InvokeFunction grant. run_terraform is
  # listed once even though both state machines invoke it. distinct()
  # collapses duplicates.
  invokable_lambda_arns = distinct(concat(
    values(var.provisioning_lambda_arns),
    values(var.deprovisioning_lambda_arns),
  ))
}

# ---------------------------------------------------------------------------
# Shared state machine IAM role
# ---------------------------------------------------------------------------
# One role for both state machines. Trust: states.amazonaws.com. Inline
# policy grants lambda:InvokeFunction on every Lambda ARN either machine
# may call (union via distinct()), CloudWatch log delivery actions for
# SFN execution-history logging, and X-Ray write actions for the
# tracing_configuration blocks. Sharing one role is appropriate because
# both machines have the same security posture (Ironforge platform-side
# control plane, not user-tenant) and the action set is identical except
# for the resource list — splitting would duplicate IAM with no boundary
# benefit.

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "state_machine" {
  # Historical name kept (would otherwise be ironforge-${env}-sfn for
  # symmetry with the now-shared role). IAM role names force replacement
  # on change, which would briefly invalidate the running provisioning
  # state machine's role_arn during apply. Renaming is cosmetic; not
  # worth the apply-window risk.
  name               = "ironforge-${var.environment}-provisioning-sfn"
  assume_role_policy = data.aws_iam_policy_document.assume.json

  tags = {
    "ironforge-component"   = "step-functions"
    "ironforge-environment" = var.environment
    Name                    = "ironforge-${var.environment}-provisioning-sfn"
  }
}

data "aws_iam_policy_document" "inline" {
  statement {
    sid       = "InvokeTaskLambdas"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = local.invokable_lambda_arns
  }

  # Step Functions execution-history logging requires the resource-policy
  # vending actions on Resource: "*" — AWS limitation, documented at
  # https://docs.aws.amazon.com/step-functions/latest/dg/cw-logs.html.
  statement {
    sid    = "WriteExecutionLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }

  # X-Ray trace ingestion requires Resource: "*" — same constraint as the
  # Lambda module's tracing block (see infra/modules/lambda/main.tf).
  statement {
    sid    = "TracingPutTraces"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "inline" {
  name   = "inline"
  role   = aws_iam_role.state_machine.id
  policy = data.aws_iam_policy_document.inline.json
}

# ---------------------------------------------------------------------------
# Execution log groups (one per state machine)
# ---------------------------------------------------------------------------
# Standard workflows write per-execution event histories to CloudWatch when
# logging_configuration is set. /aws/vendedlogs/states/* is the path AWS
# expects for SFN-vended logs (matters for the resource-policy auto-creation
# the SFN service does on first execution).

resource "aws_cloudwatch_log_group" "provisioning" {
  name              = "/aws/vendedlogs/states/${local.provisioning_state_machine_name}"
  retention_in_days = var.log_retention_days

  # AWS-managed encryption per ADR-003 — execution histories don't meet the
  # CMK criteria. Override locally if a future audit requirement changes
  # this calculus.

  tags = local.component_tags_provisioning
}

# Resource address changed from `state_machine` → `provisioning` when
# the second state machine landed; physical name unchanged. The moved
# block tells terraform to migrate state in place rather than
# destroy/recreate (which would lose existing execution-history logs
# during the apply gap).
moved {
  from = aws_cloudwatch_log_group.state_machine
  to   = aws_cloudwatch_log_group.provisioning
}

resource "aws_cloudwatch_log_group" "deprovisioning" {
  name              = "/aws/vendedlogs/states/${local.deprovisioning_state_machine_name}"
  retention_in_days = var.log_retention_days

  tags = local.component_tags_deprovisioning
}

# ---------------------------------------------------------------------------
# State machines
# ---------------------------------------------------------------------------

resource "aws_sfn_state_machine" "provisioning" {
  name       = local.provisioning_state_machine_name
  type       = "STANDARD"
  role_arn   = aws_iam_role.state_machine.arn
  definition = local.provisioning_definition

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.provisioning.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  tracing_configuration {
    enabled = true
  }

  tags = local.component_tags_provisioning

  depends_on = [
    aws_iam_role_policy.inline,
  ]
}

resource "aws_sfn_state_machine" "deprovisioning" {
  name       = local.deprovisioning_state_machine_name
  type       = "STANDARD"
  role_arn   = aws_iam_role.state_machine.arn
  definition = local.deprovisioning_definition

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.deprovisioning.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  tracing_configuration {
    enabled = true
  }

  tags = local.component_tags_deprovisioning

  depends_on = [
    aws_iam_role_policy.inline,
  ]
}
