locals {
  media_bucket  = "dawai-media-${data.aws_caller_identity.me.account_id}"
  backup_bucket = "dawai-backups-${data.aws_caller_identity.me.account_id}"
  buckets = {
    media   = local.media_bucket
    backups = local.backup_bucket
  }
}

# ------------------------------------------------------------------ media (prescriptions, lab reports, voice)
resource "aws_s3_bucket" "media" {
  bucket        = local.media_bucket
  force_destroy = var.force_destroy
}

# ------------------------------------------------------------------ backups + deploy bundles
resource "aws_s3_bucket" "backups" {
  bucket        = local.backup_bucket
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "all" {
  for_each                = local.buckets
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
  depends_on              = [aws_s3_bucket.media, aws_s3_bucket.backups]
}

# SSE-S3 (AES256): free. A customer KMS key would cost $1/month for no extra protection against our threat model.
resource "aws_s3_bucket_server_side_encryption_configuration" "all" {
  for_each   = local.buckets
  bucket     = each.value
  depends_on = [aws_s3_bucket.media, aws_s3_bucket.backups]
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "tls_only" {
  for_each = local.buckets
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::${each.value}", "arn:aws:s3:::${each.value}/*"]
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

resource "aws_s3_bucket_policy" "tls_only" {
  for_each   = local.buckets
  bucket     = each.value
  policy     = data.aws_iam_policy_document.tls_only[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.all]
}

# Media is versioned so an overwrite or an accidental delete can be undone, but noncurrent versions
# expire after 7 days, so a user's DELETE really erases their files within a week (privacy policy, M4 note).
resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket     = aws_s3_bucket.media.id
  depends_on = [aws_s3_bucket_versioning.media]

  rule {
    id     = "media-retention"
    status = "Enabled"
    filter {
      prefix = "media/"
    }
    expiration {
      days = var.media_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }

  rule {
    id     = "demo-uploads"
    status = "Enabled"
    filter {
      prefix = "demo/"
    }
    expiration {
      days = 1
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  rule {
    id     = "everything-else-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "database-and-redis-dumps"
    status = "Enabled"
    filter {
      prefix = "postgres/"
    }
    expiration {
      days = 30
    }
  }

  rule {
    id     = "redis-dumps"
    status = "Enabled"
    filter {
      prefix = "redis/"
    }
    expiration {
      days = 14
    }
  }

  rule {
    id     = "deploy-bundles"
    status = "Enabled"
    filter {
      prefix = "deploy/"
    }
    expiration {
      days = 90
    }
  }
}
