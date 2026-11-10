output "instance_id" {
  value       = aws_instance.app.id
  description = "Used by scripts/aws-start.sh, aws-stop.sh and the deploy workflow (repo variable EC2_INSTANCE_ID)"
}

output "name_servers" {
  value       = aws_route53_zone.main.name_servers
  description = "Add these four as NS records at GoDaddy: host `dawai`, one record each"
}

output "site_url" {
  value = "https://${local.site_domain}"
}

output "api_url" {
  value = "https://${local.api_domain}"
}

output "webhook_url" {
  value       = "https://${local.api_domain}/webhook/whatsapp"
  description = "Callback URL for the Meta app"
}

output "media_bucket" {
  value = aws_s3_bucket.media.bucket
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.bucket
}

output "ecr_registry" {
  value = "${data.aws_caller_identity.me.account_id}.dkr.ecr.${var.region}.amazonaws.com"
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "github_deploy_role_arn" {
  value       = aws_iam_role.github_deploy.arn
  description = "Repo variable AWS_DEPLOY_ROLE_ARN for deploy.yml"
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
