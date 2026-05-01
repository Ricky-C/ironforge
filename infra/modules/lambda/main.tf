# Generic Ironforge Lambda module — provisions the IAM role (with
# IronforgePermissionBoundary attached), inline IAM policy assembled from
# structured `iam_grants` inputs, CloudWatch log group, and the Lambda
# function itself with X-Ray tracing.
#
# See README.md for the iam_grants surface convention. See ADR-006 for the
# permission boundary rationale (positive-list ALLOW, defense-in-depth DENY).

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.name

  log_group_name = "/aws/lambda/${var.function_name}"

  component_tags = {
    "ironforge-component"   = "lambda"
    "ironforge-environment" = var.environment
  }
}

# ---------------------------------------------------------------------------
# Source bundle — zipped on plan from var.source_dir. CI runs the build
# before `terraform plan` so the directory exists; archive_file fails fast
# if it does not, surfacing the missing build step at plan time.
# ---------------------------------------------------------------------------

data "archive_file" "source" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.module}/.terraform-builds/${var.function_name}.zip"
}

# ---------------------------------------------------------------------------
# Execution role + permission boundary attachment + inline IAM policy.
# Per CLAUDE.md "Lambdas have purpose-specific roles. No shared
# `ironforge-lambda-role`." Each Lambda gets exactly the perms it needs.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "assume_role" {
  statement {
    sid     = "LambdaServiceAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name                 = "${var.function_name}-execution"
  assume_role_policy   = data.aws_iam_policy_document.assume_role.json
  permissions_boundary = var.permission_boundary_arn

  tags = local.component_tags
}

# Inline policy assembled from the structured iam_grants. The dynamic
# blocks below emit one statement per category that has non-empty input;
# empty categories produce no statement (no widening, no syntax noise in
# the generated policy JSON).
data "aws_iam_policy_document" "execution_inline" {
  statement {
    sid     = "AllowOwnLogGroup"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${local.log_group_name}:*",
    ]
  }

  # X-Ray write actions are account-scoped per AWS service authorization
  # reference (see docs/iam-exceptions.md). Boundary allows; we mirror
  # here only when tracing is enabled.
  dynamic "statement" {
    for_each = var.tracing_mode == "Active" ? [1] : []
    content {
      sid       = "AllowXRayWrite"
      effect    = "Allow"
      actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = length(var.iam_grants.dynamodb_read) > 0 ? [1] : []
    content {
      sid    = "AllowDynamoDBRead"
      effect = "Allow"
      actions = [
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:BatchGetItem",
        "dynamodb:DescribeTable",
      ]
      resources = var.iam_grants.dynamodb_read
    }
  }

  dynamic "statement" {
    for_each = length(var.iam_grants.dynamodb_write) > 0 ? [1] : []
    content {
      sid    = "AllowDynamoDBWrite"
      effect = "Allow"
      actions = [
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:BatchWriteItem",
      ]
      resources = var.iam_grants.dynamodb_write
    }
  }

  dynamic "statement" {
    for_each = var.iam_grants.extra_statements
    content {
      sid       = statement.value.sid
      effect    = statement.value.effect
      actions   = statement.value.actions
      resources = statement.value.resources

      dynamic "condition" {
        for_each = statement.value.conditions
        content {
          test     = condition.value.test
          variable = condition.value.variable
          values   = condition.value.values
        }
      }
    }
  }
}

resource "aws_iam_role_policy" "execution_inline" {
  name   = "${var.function_name}-inline"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_inline.json
}

# ---------------------------------------------------------------------------
# Log group — provisioned explicitly so retention is enforced. Lambda's
# auto-created log group has indefinite retention by default, which the
# permission boundary doesn't constrain.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days

  # AWS-managed encryption per ADR-003 — execution logs do not meet the
  # CMK criteria. Override via extra_statements + a CMK key arn passed
  # in only when handler logs contain genuinely sensitive content.

  tags = local.component_tags
}

# ---------------------------------------------------------------------------
# Function — created last so the role + log group + policy exist before
# the function attempts to invoke. depends_on the inline policy so the
# function's first invocation can't race the policy's eventual consistency.
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  role          = aws_iam_role.execution.arn

  filename         = data.archive_file.source.output_path
  source_code_hash = data.archive_file.source.output_base64sha256

  handler       = var.handler
  runtime       = var.runtime
  architectures = [var.architecture]

  memory_size = var.memory_mb
  timeout     = var.timeout_seconds

  reserved_concurrent_executions = var.reserved_concurrent_executions

  tracing_config {
    mode = var.tracing_mode
  }

  dynamic "environment" {
    for_each = length(var.environment_variables) > 0 ? [1] : []
    content {
      variables = var.environment_variables
    }
  }

  tags = local.component_tags

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.execution_inline,
  ]
}
