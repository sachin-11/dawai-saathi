#!/usr/bin/env bash
# scripts/aws-stop.sh      stop the instance (make stop). The OS shutdown runs dawai.service's ExecStop first:
# database + Redis dump to S3, then the containers are stopped so workers finish their jobs.
# A stopped instance still bills for its disk (~$2/month) but not for compute.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-ap-south-1}"
ID="${INSTANCE_ID:-$(terraform -chdir=infra/terraform output -raw instance_id)}"
aws ec2 stop-instances --region "$REGION" --instance-ids "$ID" >/dev/null
echo "stopping $ID ... (waiting)"
aws ec2 wait instance-stopped --region "$REGION" --instance-ids "$ID"
echo "stopped."
