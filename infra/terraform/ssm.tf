# Non-secret configuration, read by render-env.sh next to the secrets.
#
#   /dawai/prod/config/*   String          created HERE (domains, bucket names, registry)
#   /dawai/prod/secrets/*  SecureString    NEVER created here: a value written by Terraform would sit in the
#                                          state file in plaintext. Fill them with scripts/put-secrets.sh.
#
# Other config you set by hand with scripts/put-secrets.sh --config (LLM_PRIMARY, VISION_MODEL, ...). Keys
# that Terraform manages are listed below; do not set the same key by hand.

locals {
  managed_config = {
    DOMAIN               = local.site_domain
    API_DOMAIN           = local.api_domain
    ACME_EMAIL           = var.acme_email
    ECR_REGISTRY         = "${data.aws_caller_identity.me.account_id}.dkr.ecr.${var.region}.amazonaws.com"
    S3_BUCKET            = local.media_bucket
    BACKUP_BUCKET        = local.backup_bucket
    AWS_REGION           = var.region
    ALLOWED_MEDIA_HOSTS  = "${local.media_bucket}.s3.${var.region}.amazonaws.com"
    PRIVACY_POLICY_URL   = "https://${local.site_domain}/privacy"
    MEDIA_RETENTION_DAYS = tostring(var.media_retention_days)
    NEXT_PUBLIC_SITE_URL = "https://${local.site_domain}"
  }
}

resource "aws_ssm_parameter" "config" {
  for_each = local.managed_config
  name     = "/dawai/prod/config/${each.key}"
  type     = "String"
  value    = each.value
}

# The release the instance should run. CI writes it after pushing images (so a stopped instance deploys it at
# its next boot); Terraform only creates the parameter.
resource "aws_ssm_parameter" "desired_sha" {
  name  = "/dawai/prod/config/DESIRED_SHA"
  type  = "String"
  value = "none"

  lifecycle {
    ignore_changes = [value]
  }
}
