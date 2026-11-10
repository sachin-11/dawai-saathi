# One public subnet, no NAT gateway (a NAT costs ~$32/month). The instance has a public IP and a security
# group that only lets 80/443 in. There is no RDS in demo mode, so there are no private subnets yet:
# add two (in two AZs) and a subnet group when moving Postgres to RDS (docs/runbooks/rds-upgrade.md).

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = data.aws_availability_zones.available.names
}

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "dawai" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "dawai" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.0.0/24"
  availability_zone       = local.azs[var.az_index]
  map_public_ip_on_launch = true
  tags                    = { Name = "dawai-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "dawai-public" }

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# S3 traffic (media, backups, presigned URLs fetched by the AI service) stays inside AWS and is free.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]
  tags              = { Name = "dawai-s3" }
}

# The default security group of the VPC allows nothing (no rules), so nothing can use it by accident.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "dawai-default-unused" }
}

# ---- security group: 80/443 from anywhere, nothing else. No SSH (port 22): access is SSM Session Manager.
resource "aws_security_group" "app" {
  name        = "dawai-app"
  description = "Dawai Saathi instance: HTTP and HTTPS only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "dawai-app" }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.app.id
  description       = "HTTP for the Lets Encrypt challenge and the redirect to HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "http3" {
  security_group_id = aws_security_group.app.id
  description       = "HTTP/3 (QUIC)"
  ip_protocol       = "udp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# Egress is open: the instance calls Meta, the LLM and speech providers, ECR, SSM and Let's Encrypt.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.app.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
