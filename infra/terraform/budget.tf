# The cost guard (limit: var.monthly_budget_usd, default $10).
#   * e-mail at 50% / 80% / 100% of ACTUAL spend and when the FORECAST passes 100%
#   * at var.budget_stop_usd (default $8) of ACTUAL spend a Budget Action STOPS the instance automatically
# AWS Budgets is NOT a hard cap: cost data arrives up to about a day late, so a stop can come after the
# line was crossed. That is why the stop threshold sits below the limit and every boot also has a time limit
# (max_uptime_minutes). The budget covers the whole account, not only this project.

resource "aws_budgets_budget" "monthly" {
  name         = "dawai-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alarm_email]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alarm_email]
  }
}

data "aws_iam_policy_document" "budgets_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "budget_action" {
  name               = "dawai-budget-action"
  assume_role_policy = data.aws_iam_policy_document.budgets_assume.json
}

# Only these actions on this ONE instance.
data "aws_iam_policy_document" "budget_action" {
  statement {
    actions   = ["ec2:StopInstances", "ec2:StartInstances"]
    resources = [aws_instance.app.arn]
  }
  statement {
    actions   = ["ec2:DescribeInstanceStatus", "ec2:DescribeInstances"]
    resources = ["*"]
  }
  statement {
    actions   = ["ssm:StartAutomationExecution", "ssm:GetAutomationExecution"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "budget_action" {
  name   = "stop-the-instance"
  role   = aws_iam_role.budget_action.id
  policy = data.aws_iam_policy_document.budget_action.json
}

resource "aws_budgets_budget_action" "stop_instance" {
  budget_name        = aws_budgets_budget.monthly.name
  action_type        = "RUN_SSM_DOCUMENTS"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budget_action.arn

  action_threshold {
    action_threshold_type  = "ABSOLUTE_VALUE"
    action_threshold_value = var.budget_stop_usd
  }

  definition {
    ssm_action_definition {
      action_sub_type = "STOP_EC2_INSTANCES"
      region          = var.region
      instance_ids    = [aws_instance.app.id]
    }
  }

  subscriber {
    subscription_type = "EMAIL"
    address           = var.alarm_email
  }
}
