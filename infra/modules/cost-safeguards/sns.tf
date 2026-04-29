# SNS fan-out for cost alerts. Used by Cost Anomaly Detection and the
# daily cost reporter Lambda (Commit 5). Budget alerts go direct-to-email
# rather than through SNS to avoid duplicate notifications.

resource "aws_sns_topic" "cost_alerts" {
  name              = "ironforge-cost-alerts"
  kms_master_key_id = "alias/aws/sns"

  tags = local.component_tags
}

data "aws_iam_policy_document" "sns_publish" {
  statement {
    sid    = "AllowCostAnomalyPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["costalerts.amazonaws.com"]
    }

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.cost_alerts.arn]

    # Confused-deputy mitigation: scope the AWS service principal to this
    # account only. Cost Anomaly Detection in another account cannot publish
    # here even if it knew the topic ARN. Mirrors the budget_action_trust
    # pattern in budgets.tf.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "cost_alerts" {
  arn    = aws_sns_topic.cost_alerts.arn
  policy = data.aws_iam_policy_document.sns_publish.json
}

# Email subscription requires manual confirmation (AWS sends a confirm link).
# See docs/cost-safeguards.md for the manual-setup checklist.
resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.cost_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
