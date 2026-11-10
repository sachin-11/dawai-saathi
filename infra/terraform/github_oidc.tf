# GitHub Actions signs in with OIDC: no long-lived AWS key is stored in GitHub.
# The role can be assumed only by workflows of var.github_repo that run on a `v*` tag or on main.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repo}:ref:refs/tags/v*",
        "repo:${var.github_repo}:ref:refs/heads/main",
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "dawai-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
      "ecr:DescribeImageScanFindings",
    ]
    resources = [for r in aws_ecr_repository.app : r.arn]
  }
  statement {
    sid       = "ReleaseBundle"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.backups.arn}/deploy/*"]
  }
  # Run Command: this ONE instance, this ONE document.
  statement {
    sid     = "SendCommand"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.app.arn,
      "arn:${data.aws_partition.this.partition}:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }
  statement {
    sid       = "ReadCommandResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:DescribeInstanceInformation", "ec2:DescribeInstances"]
    resources = ["*"]
  }
  statement {
    sid     = "DesiredRelease"
    actions = ["ssm:PutParameter", "ssm:GetParameter"]
    resources = [
      "arn:${data.aws_partition.this.partition}:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter/dawai/prod/config/DESIRED_SHA",
    ]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "dawai-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
