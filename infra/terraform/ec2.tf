locals {
  site_domain = var.zone_name
  api_domain  = "api.${var.zone_name}"

  # Files copied to the instance at first boot: path on the instance -> content. Everything else (compose
  # file, Caddyfile, deploy.sh) arrives later as a versioned release bundle uploaded by CI.
  boot_files = merge(
    { for f in fileset("${path.module}/../deploy/boot", "*") : "/opt/dawai/boot/${f}" => filebase64("${path.module}/../deploy/boot/${f}") },
    { for f in ["dns-update.sh", "run-release.sh", "boot.sh", "stop.sh", "extend-uptime.sh", "max-uptime.sh"] :
    "/opt/dawai/bin/${f}" => filebase64("${path.module}/../deploy/boot/${f}") },
  )

  instance_env = <<-EOT
    AWS_REGION=${var.region}
    ZONE_ID=${aws_route53_zone.main.zone_id}
    DOMAIN=${local.site_domain}
    API_DOMAIN=${local.api_domain}
    ARTIFACT_BUCKET=${local.backup_bucket}
    MAX_UPTIME_MIN=${var.max_uptime_minutes}
    SWAP_GB=${var.swap_gb}
    DNS_TTL=60
  EOT

  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    mkdir -p /etc/dawai /opt/dawai/bin /opt/dawai/boot /opt/dawai/releases
    echo '${base64encode(local.instance_env)}' | base64 -d > /etc/dawai/instance.env
    %{for path, b64 in local.boot_files~}
    echo '${b64}' | base64 -d > ${path}
    %{endfor~}
    chmod +x /opt/dawai/bin/*.sh /opt/dawai/boot/*.sh
    bash /opt/dawai/boot/bootstrap.sh
  EOT
}

# Amazon Linux 2023 (x86_64 or arm64): AWS-maintained, SSM agent preinstalled, no SSH needed.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${var.architecture}"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  key_name               = null # no key pair: there is no SSH

  associate_public_ip_address          = true
  instance_initiated_shutdown_behavior = "stop" # the auto-stop must STOP, never terminate
  disable_api_termination              = false  # `terraform destroy` has to work; protection is the explicit "apply" rule
  ebs_optimized                        = true   # t4g is EBS-optimized by default; stated for the scanner
  monitoring                           = false  # basic 5-minute metrics are free

  # IMDSv2 only. Hop limit 2 so containers (one more hop) can still use the instance role for S3.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  # Burstable T instances default to "unlimited" credits on some families (t3), which BILLS extra CPU time.
  # "standard" throttles instead of charging: the budget cannot be surprised by a busy instance.
  dynamic "credit_specification" {
    for_each = startswith(var.instance_type, "t") ? [1] : []
    content {
      cpu_credits = "standard"
    }
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  user_data_base64            = base64gzip(local.user_data)
  user_data_replace_on_change = false # editing the boot scripts must never rebuild the machine (and its data)

  tags = { Name = "dawai-app" }

  lifecycle {
    # The AMI id changes with every AWS release and user data only runs on first boot.
    ignore_changes = [ami, user_data_base64]
  }
}
