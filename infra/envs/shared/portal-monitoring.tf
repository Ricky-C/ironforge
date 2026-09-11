# ============================================================================
# Portal health monitoring — alarms so a silent portal outage can't recur
# ============================================================================
#
# Context: in 2026-06 the portal returned CloudFront 502 BadGatewayException
# for ~1 month with ZERO alerting. The daily keepalive (aws_cloudwatch_event_
# rule.portal_keepalive) async-invokes the portal Lambda; when the function
# can't cold-start (e.g. the ECR ImageAccessDenied fixed in modules/portal-
# lambda), the async invokes are accepted (HTTP 202) then dropped after
# retries — incrementing AWS/Lambda AsyncEventsDropped while FailedInvocations,
# Invocations, and Errors all stay flat. Every health metric read green while
# the site was down. See docs/runbook.md § 5 and docs/tech-debt.md.
#
# This wires two complementary alarms to a dedicated SNS topic so the failure
# pages instead of hiding:
#   - portal_keepalive_dropped : keepalive ran but the function couldn't
#       execute (the exact signature of the 2026-06 outage).
#   - portal_not_invoked       : the function isn't being invoked at all
#       (keepalive rule disabled/deleted) — it will drift to Inactive.
#
# Why a dedicated CMK (not the cost-alerts topic's alias/aws/sns): a
# CloudWatch alarm CANNOT deliver to a topic encrypted with the AWS-managed
# aws/sns key — the alarm action fails with "CloudWatch Alarms does not have
# authorization to access the SNS topic encryption key", and that managed key
# policy can't be edited to grant cloudwatch.amazonaws.com. The encrypt-at-
# rest baseline (CLAUDE.md / CKV_AWS_26) still applies, so the only working
# option is a CMK whose policy grants CloudWatch. This is a documented
# ADR-003 amendment (criterion 5: functional service-integration requirement).

# ----------------------------------------------------------------------------
# CMK — encrypts the ops-alerts topic so CloudWatch alarms can publish to it.
# ----------------------------------------------------------------------------

resource "aws_kms_key" "ops_alerts" {
  description             = "Encrypts the ironforge-ops-alerts SNS topic so CloudWatch alarms can publish (alias/aws/sns cannot grant cloudwatch.amazonaws.com). See ADR-003 amendment 2026-06-29."
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.ops_alerts_kms.json

  tags = {
    "ironforge-component" = "portal-lambda"
    "ironforge-managed"   = "true"
    Name                  = "ironforge-ops-alerts"
  }
}

resource "aws_kms_alias" "ops_alerts" {
  name          = "alias/ironforge-ops-alerts"
  target_key_id = aws_kms_key.ops_alerts.id
}

data "aws_iam_policy_document" "ops_alerts_kms" {
  # Standard root grant — recovery path if the other statements misconfigure.
  # Resource:"*" refers to this key (the policy IS the key's authorization
  # document). CKV_AWS_109/111/356 are skipped for KMS key policies (.checkov.yml).
  statement {
    sid    = "EnableRootAccountAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  # CloudWatch alarms call GenerateDataKey/Decrypt to publish the encrypted
  # notification. Unlike the cloudtrail CMK's service statements, this one is
  # intentionally UNCONDITIONED: the documented working policy for CloudWatch
  # -> encrypted-SNS (AWS re:Post "Configure a CloudWatch alarm with an
  # encrypted SNS topic") carries no aws:SourceAccount/aws:SourceArn, and the
  # presence of those keys in CloudWatch's KMS request context is undocumented
  # -- a non-matching condition would silently break delivery (the failure
  # mode this whole file exists to prevent). Account-scoping lives on the SNS
  # topic policy below, where aws:SourceAccount is reliably supported. The key
  # is single-purpose (only this topic uses it), so an unconditioned grant to
  # the cloudwatch service principal has negligible blast radius.
  statement {
    sid    = "AllowCloudWatchAlarmsUseOfKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
  }

  # SNS uses the key for server-side encryption at rest and to decrypt on
  # delivery to the email subscriber. Mirrors what alias/aws/sns grants the
  # SNS service for the cost-alerts topic.
  statement {
    sid    = "AllowSNSUseOfKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
  }
}

# ----------------------------------------------------------------------------
# Ops-alerts SNS topic + email subscription.
# ----------------------------------------------------------------------------

resource "aws_sns_topic" "ops_alerts" {
  name              = "ironforge-ops-alerts"
  kms_master_key_id = aws_kms_key.ops_alerts.id

  tags = {
    "ironforge-component" = "portal-lambda"
    "ironforge-managed"   = "true"
    Name                  = "ironforge-ops-alerts"
  }
}

# Account-scoped publish grant for CloudWatch alarms. Resource policies are
# additive, so this can only widen access (it never blocks the account owner);
# the aws:SourceAccount condition stops any other account's CloudWatch from
# publishing here even if it learned the topic ARN.
data "aws_iam_policy_document" "ops_alerts_topic" {
  statement {
    sid    = "AllowCloudWatchAlarmsPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ops_alerts.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "ops_alerts" {
  arn    = aws_sns_topic.ops_alerts.arn
  policy = data.aws_iam_policy_document.ops_alerts_topic.json
}

# Email subscription requires one-time manual confirmation (AWS emails a
# confirm link to var.alert_email). This is a SEPARATE topic from cost-alerts,
# so it needs its own confirmation even if the address already confirmed there.
# See docs/cost-safeguards.md for the same manual-confirm pattern.
resource "aws_sns_topic_subscription" "ops_alerts_email" {
  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ----------------------------------------------------------------------------
# Alarms.
# ----------------------------------------------------------------------------

# Primary detector — the empirically-validated signature of the 2026-06
# outage: the daily keepalive's async invoke was dropped because the function
# couldn't cold-start. AsyncEventsDropped is emitted only when a drop occurs,
# so "no data" == healthy (notBreaching). Period matches the daily keepalive
# cadence so a sustained outage stays in one ALARM state (one notification)
# rather than flapping.
resource "aws_cloudwatch_metric_alarm" "portal_keepalive_dropped" {
  alarm_name        = "ironforge-portal-keepalive-dropped"
  alarm_description = "Portal async invoke (the daily keepalive) was DROPPED — the function likely can't cold-start (e.g. ECR ImageAccessDenied). Exact signature of the 2026-06 month-long silent outage. Runbook: docs/runbook.md § 5."

  namespace   = "AWS/Lambda"
  metric_name = "AsyncEventsDropped"
  dimensions = {
    FunctionName = aws_lambda_function.portal.function_name
  }

  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  ok_actions    = [aws_sns_topic.ops_alerts.arn]

  tags = {
    "ironforge-component" = "portal-lambda"
    "ironforge-managed"   = "true"
  }
}

# Complementary detector — catches the case the primary can't see: the
# keepalive rule itself stopped firing (disabled/deleted), so there are no
# async invokes to drop. With one keepalive/day, the daily Invocations sum is
# >=1 when healthy; missing data (zero invocations in a day) is treated as
# breaching. The function would otherwise silently drift to Inactive.
resource "aws_cloudwatch_metric_alarm" "portal_not_invoked" {
  alarm_name        = "ironforge-portal-not-invoked-24h"
  alarm_description = "Portal Lambda had zero invocations in 24h — the daily keepalive isn't reaching it (rule disabled/deleted or invokes failing upstream). Function will drift to Inactive. Runbook: docs/runbook.md § 5."

  namespace   = "AWS/Lambda"
  metric_name = "Invocations"
  dimensions = {
    FunctionName = aws_lambda_function.portal.function_name
  }

  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  ok_actions    = [aws_sns_topic.ops_alerts.arn]

  tags = {
    "ironforge-component" = "portal-lambda"
    "ironforge-managed"   = "true"
  }
}
