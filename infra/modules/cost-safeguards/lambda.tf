# Daily cost reporter Lambda. Runs at 14:00 UTC, queries Cost Explorer for
# yesterday's spend, publishes a summary to the cost-alerts SNS topic.
#
# Build artifact requirement:
# `pnpm --filter @ironforge/cost-reporter build` must run before
# `terraform apply`. CI does this in the infra-apply workflow (Commit 11).
# data.archive_file fails plan if dist/index.js is missing.
# See docs/cost-safeguards.md § "Building the cost-reporter Lambda".

# Log group uses AWS-managed encryption (no kms_key_id specified). Per ADR-003,
# CMK is reserved for content with specific access-control or compliance needs.
# Cost Explorer query results and daily summaries are operational data — none
# of ADR-003's criteria apply.
resource "aws_cloudwatch_log_group" "cost_reporter" {
  name              = "/aws/lambda/ironforge-cost-reporter"
  retention_in_days = 30

  tags = local.component_tags
}

# Lambda execution role.
# Permission boundary will be added in Commit 10 when IronforgePermissionBoundary
# lands. The role's narrow inline policy below is the only access for now.
data "aws_iam_policy_document" "cost_reporter_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cost_reporter" {
  name               = "ironforge-cost-reporter"
  assume_role_policy = data.aws_iam_policy_document.cost_reporter_trust.json

  tags = local.component_tags
}

data "aws_iam_policy_document" "cost_reporter_permissions" {
  statement {
    sid    = "CloudWatchLogsWrite"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.cost_reporter.arn}:*"]
  }

  # ce:GetCostAndUsage does not support resource-level permissions per
  # AWS service authorization reference. Resource: "*" is required.
  # See docs/iam-exceptions.md.
  statement {
    sid       = "CostExplorerRead"
    effect    = "Allow"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"]
  }

  statement {
    sid       = "SNSPublishCostAlerts"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.cost_alerts.arn]
  }

  # X-Ray write actions are account-scoped and don't accept resource-level
  # permissions. See docs/iam-exceptions.md.
  statement {
    sid    = "XRayWrite"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "cost_reporter" {
  name   = "ironforge-cost-reporter"
  role   = aws_iam_role.cost_reporter.id
  policy = data.aws_iam_policy_document.cost_reporter_permissions.json
}

# Built artifact: services/cost-reporter/dist/index.js (esbuild output).
# Plan fails if this file is missing — run `pnpm build` first.
data "archive_file" "cost_reporter" {
  type        = "zip"
  source_file = "${path.module}/../../../services/cost-reporter/dist/index.js"
  output_path = "${path.module}/.cache/cost-reporter.zip"
}

resource "aws_lambda_function" "cost_reporter" {
  function_name    = "ironforge-cost-reporter"
  role             = aws_iam_role.cost_reporter.arn
  filename         = data.archive_file.cost_reporter.output_path
  source_code_hash = data.archive_file.cost_reporter.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  timeout          = 30
  memory_size      = 128

  environment {
    variables = {
      SNS_TOPIC_ARN = aws_sns_topic.cost_alerts.arn
      LOG_LEVEL     = "INFO"
    }
  }

  tracing_config {
    mode = "Active"
  }

  tags = merge(local.component_tags, {
    Name = "ironforge-cost-reporter"
  })

  depends_on = [
    aws_iam_role_policy.cost_reporter,
    aws_cloudwatch_log_group.cost_reporter,
  ]
}

# EventBridge Rule: 14:00 UTC daily (09:00 Central).
# Using EventBridge Rules (not the newer EventBridge Scheduler) for simpler IAM —
# Scheduler would need an extra service role to invoke Lambda. For one cron Lambda,
# Rules + lambda_permission is the lighter pattern.
resource "aws_cloudwatch_event_rule" "cost_reporter_daily" {
  name                = "ironforge-cost-reporter-daily"
  description         = "Trigger daily cost report at 14:00 UTC (09:00 Central)"
  schedule_expression = "cron(0 14 * * ? *)"

  tags = local.component_tags
}

resource "aws_cloudwatch_event_target" "cost_reporter_daily" {
  rule      = aws_cloudwatch_event_rule.cost_reporter_daily.name
  target_id = "cost-reporter"
  arn       = aws_lambda_function.cost_reporter.arn
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cost_reporter.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cost_reporter_daily.arn
}
