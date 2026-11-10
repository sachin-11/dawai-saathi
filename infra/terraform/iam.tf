# ------------------------------------------------------------------ the instance role (no access keys anywhere)
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "dawai-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Session Manager (shell without SSH) + SSM Run Command (deploys). AWS-managed, narrow in scope.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:${data.aws_partition.this.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "instance" {
  # ECR: pull only (the token call has no resource-level scoping).
  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchCheckLayerAvailability",
      "ecr:DescribeImages",
    ]
    resources = [for r in aws_ecr_repository.app : r.arn]
  }

  # Media bucket: the gateway reads, writes and deletes objects (DELETE command, retention) and presigns URLs.
  statement {
    sid       = "MediaObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:GetObjectVersion", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }
  statement {
    sid       = "MediaList"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.media.arn]
  }

  # Backups bucket: write dumps, read deploy bundles, nothing else.
  statement {
    sid       = "BackupsWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.backups.arn}/postgres/*", "${aws_s3_bucket.backups.arn}/redis/*"]
  }
  statement {
    sid       = "BackupsReadForRestore"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }
  statement {
    sid       = "BackupsList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }

  # Parameter Store: ONLY /dawai/prod/*.
  statement {
    sid     = "ParametersRead"
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [
      "arn:${data.aws_partition.this.partition}:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter/dawai/prod",
      "arn:${data.aws_partition.this.partition}:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter/dawai/prod/*",
    ]
  }
  statement {
    sid       = "DecryptSecureStrings"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }

  # DNS: change the A records of this one zone (the IP changes at every start).
  statement {
    sid       = "DnsUpdate"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = [aws_route53_zone.main.arn]
  }

  # Docker's awslogs driver writes to the log groups made in monitoring.tf.
  statement {
    sid       = "ContainerLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["arn:${data.aws_partition.this.partition}:logs:${var.region}:${data.aws_caller_identity.me.account_id}:log-group:/dawai/*:*"]
  }
}

resource "aws_iam_role_policy" "instance" {
  name   = "dawai-instance"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "dawai-instance"
  role = aws_iam_role.instance.name
}
