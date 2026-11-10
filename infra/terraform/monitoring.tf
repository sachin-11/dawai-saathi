# Logs, alarms and e-mail. Kept small on purpose: every custom metric and alarm costs money.
# What is NOT here: memory/disk metrics (need the CloudWatch agent: ~$0.30 per metric per month), a Route 53
# health check ($0.50/month, and meaningless while the instance is stopped on purpose), and the M15
# Prometheus alerts (they need the Prometheus/Grafana stack, which is not deployed on the demo instance).

locals {
  log_groups = ["caddy", "gateway-api", "gateway-worker", "ai-service", "web", "redis", "postgres"]
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(local.log_groups)
  name              = "/dawai/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_sns_topic" "alarms" {
  name = "dawai-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email # AWS sends a confirmation mail: click it, or no alarm reaches you
}

# A stopped instance reports no data: that is normal here, so missing data is "not breaching".
resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "dawai-instance-status-check-failed"
  alarm_description   = "EC2 system or instance status check failed (runbook: docs/runbooks/restore.md)"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 3
  treat_missing_data  = "notBreaching"
  dimensions          = { InstanceId = aws_instance.app.id }
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "cpu" {
  alarm_name          = "dawai-cpu-high"
  alarm_description   = "CPU above 80% for 15 minutes (t4g credits run out: see docs/runbooks/restore.md, sizing)"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  period              = 300
  evaluation_periods  = 3
  treat_missing_data  = "notBreaching"
  dimensions          = { InstanceId = aws_instance.app.id }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

# T4g instances are burstable; running out of CPU credits slows everything down.
resource "aws_cloudwatch_metric_alarm" "cpu_credits" {
  alarm_name          = "dawai-cpu-credits-low"
  alarm_description   = "CPU credit balance below 20: the instance is about to be throttled"
  namespace           = "AWS/EC2"
  metric_name         = "CPUCreditBalance"
  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 20
  period              = 300
  evaluation_periods  = 2
  treat_missing_data  = "notBreaching"
  dimensions          = { InstanceId = aws_instance.app.id }
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

# 5xx answered by Caddy (the JSON access log has a top-level `status`).
resource "aws_cloudwatch_log_metric_filter" "caddy_5xx" {
  name           = "dawai-caddy-5xx"
  log_group_name = aws_cloudwatch_log_group.app["caddy"].name
  pattern        = "{ $.status >= 500 }"

  metric_transformation {
    name          = "Http5xx"
    namespace     = "Dawai"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "http_5xx" {
  alarm_name          = "dawai-http-5xx"
  alarm_description   = "5 or more 5xx responses in 5 minutes (runbook: docs/runbooks/webhook-5xx.md)"
  namespace           = "Dawai"
  metric_name         = "Http5xx"
  statistic           = "Sum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
