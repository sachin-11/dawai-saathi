# Only the subdomain is delegated to Route 53 (about $0.50/month). rasuonline.in itself stays at GoDaddy and
# is not touched: after `terraform apply` add the four NS records from the output `name_servers` at GoDaddy
# (type NS, host `dawai`). The A records of the site and the API are written by the instance at every boot
# (infra/deploy/boot/dns-update.sh), so no Elastic IP is needed.

resource "aws_route53_zone" "main" {
  name          = var.zone_name
  comment       = "Dawai Saathi (delegated subdomain)"
  force_destroy = true # the only records are the two A records the instance wrote
}
