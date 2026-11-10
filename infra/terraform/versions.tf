terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Partial configuration: `terraform init -backend-config=backend.hcl` (copy backend.hcl.example).
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "dawai-saathi"
      ManagedBy = "terraform"
      Env       = "prod"
    }
  }
}

data "aws_caller_identity" "me" {}
data "aws_partition" "this" {}
