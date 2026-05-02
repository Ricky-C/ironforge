locals {
  state_machine_name = "ironforge-${var.environment}-provisioning"

  component_tags = {
    "ironforge-component"   = "step-functions"
    "ironforge-environment" = var.environment
    Name                    = local.state_machine_name
  }

  definition = templatefile("${path.module}/definition.json.tpl", {
    validate_inputs_arn     = var.task_lambda_arns.validate_inputs
    create_repo_arn         = var.task_lambda_arns.create_repo
    generate_code_arn       = var.task_lambda_arns.generate_code
    run_terraform_arn       = var.task_lambda_arns.run_terraform
    wait_for_cloudfront_arn = var.task_lambda_arns.wait_for_cloudfront
    trigger_deploy_arn      = var.task_lambda_arns.trigger_deploy
    finalize_arn            = var.task_lambda_arns.finalize
    cleanup_on_failure_arn  = var.task_lambda_arns.cleanup_on_failure
  })
}

# ---------------------------------------------------------------------------
# State machine IAM role
# ---------------------------------------------------------------------------
# Trust: states.amazonaws.com. Inline policy: lambda:InvokeFunction scoped to
# the exact 8 task Lambda ARNs (no wildcards), CloudWatch log delivery (SFN
# logging requires a fixed set of grant actions per AWS docs), and X-Ray
# write actions for the tracing_configuration block below.

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
  name               = "${local.state_machine_name}-sfn"
  assume_role_policy = data.aws_iam_policy_document.assume.json

  tags = local.component_tags
}

data "aws_iam_policy_document" "inline" {
  statement {
    sid       = "InvokeTaskLambdas"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = values(var.task_lambda_arns)
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
# Execution log group
# ---------------------------------------------------------------------------
# Standard workflows write per-execution event histories to CloudWatch when
# logging_configuration is set. /aws/vendedlogs/states/* is the path AWS
# expects for SFN-vended logs (matters for the resource-policy auto-creation
# the SFN service does on first execution).

resource "aws_cloudwatch_log_group" "state_machine" {
  name              = "/aws/vendedlogs/states/${local.state_machine_name}"
  retention_in_days = var.log_retention_days

  # AWS-managed encryption per ADR-003 — execution histories don't meet the
  # CMK criteria. Override locally if a future audit requirement changes
  # this calculus.

  tags = local.component_tags
}

# ---------------------------------------------------------------------------
# State machine
# ---------------------------------------------------------------------------

resource "aws_sfn_state_machine" "provisioning" {
  name       = local.state_machine_name
  type       = "STANDARD"
  role_arn   = aws_iam_role.state_machine.arn
  definition = local.definition

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.state_machine.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  tracing_configuration {
    enabled = true
  }

  tags = local.component_tags

  depends_on = [
    aws_iam_role_policy.inline,
  ]
}
