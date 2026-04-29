# AWS Cost Anomaly Detection.
#
# One dimensional monitor watches all SERVICE-level spend.
# Two subscriptions each check one threshold against the same monitor:
#   - $3 absolute deviation
#   - 40% relative deviation
# Two subscriptions (rather than one OR-expression) keeps each threshold
# cleanly auditable and avoids relying on threshold_expression OR-block syntax.
#
# Frequency must be IMMEDIATE because subscribers are SNS, not email.
# AWS rejects DAILY/WEEKLY + SNS combinations: those frequencies batch
# notifications into a digest format that is only deliverable to email.
# IMMEDIATE is also the right policy for these thresholds — at $3 / 40%
# the signal is intended to fire on the first detected anomaly, not
# wait until the next daily window.

resource "aws_ce_anomaly_monitor" "all_services" {
  name              = "ironforge-all-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"

  tags = local.component_tags
}

resource "aws_ce_anomaly_subscription" "absolute_3usd" {
  name      = "ironforge-anomaly-absolute-3usd"
  frequency = "IMMEDIATE"

  monitor_arn_list = [
    aws_ce_anomaly_monitor.all_services.arn,
  ]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.cost_alerts.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["3"]
    }
  }

  tags = local.component_tags

  depends_on = [aws_sns_topic_policy.cost_alerts]
}

resource "aws_ce_anomaly_subscription" "relative_40pct" {
  name      = "ironforge-anomaly-relative-40pct"
  frequency = "IMMEDIATE"

  monitor_arn_list = [
    aws_ce_anomaly_monitor.all_services.arn,
  ]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.cost_alerts.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_PERCENTAGE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["40"]
    }
  }

  tags = local.component_tags

  depends_on = [aws_sns_topic_policy.cost_alerts]
}
