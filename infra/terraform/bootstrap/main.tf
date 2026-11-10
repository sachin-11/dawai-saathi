# One-time bootstrap: the S3 bucket that holds the Terraform state of the main stack.
# Run it ONCE with local state (never commit terraform.tfstate):
#
#   cd infra/terraform/bootstrap && terraform init && terraform apply
#
# State locking uses the S3-native lock file (`use_lockfile`, Terraform >= 1.10), so no DynamoDB table
# is needed (one resource less, nothing to pay for). Deviation from the original plan, see docs.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "dawai-saathi", ManagedBy = "terraform", Stack = "bootstrap" }
  }
}

data "aws_caller_identity" "me" {}

resource "aws_s3_bucket" "state" {
  bucket = "dawai-tfstate-${data.aws_caller_identity.me.account_id}"
  # The state is the only record of what exists: never let `terraform destroy` of this folder delete it
  # silently. Remove it by hand (empty the bucket first) when the project is over.
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "old-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "state_tls" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_tls.json
}

output "state_bucket" {
  value       = aws_s3_bucket.state.bucket
  description = "Put this in infra/terraform/backend.hcl (see backend.hcl.example)"
}
