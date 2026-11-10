#!/usr/bin/env bash
# scripts/aws-ssm.sh deploy <sha>      run a deploy (or a ROLLBACK to an older sha) on the instance through SSM
# scripts/aws-ssm.sh extend [minutes]  push the automatic shutdown further away
# scripts/aws-ssm.sh seed              load the catalog (needs CONFIRM=yes)
# scripts/aws-ssm.sh shell             interactive shell (Session Manager plugin required; there is no SSH)
#
# No SSH anywhere: this uses SSM Run Command / Session Manager with your own AWS credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-ap-south-1}"
ID="${INSTANCE_ID:-$(terraform -chdir=infra/terraform output -raw instance_id)}"

run() { # run <shell command>
  local cid
  cid="$(aws ssm send-command --region "$REGION" --instance-ids "$ID" --document-name AWS-RunShellScript \
    --comment "dawai" --timeout-seconds 1800 --parameters "commands=[\"$1\"]" --query Command.CommandId --output text)"
  echo "command $cid sent, waiting ..."
  aws ssm wait command-executed --region "$REGION" --command-id "$cid" --instance-id "$ID" || true
  aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$ID" \
    --query '[Status, StandardOutputContent, StandardErrorContent]' --output text
  [ "$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$ID" --query Status --output text)" = "Success" ]
}

case "${1:-}" in
  deploy)
    sha="${2:?usage: aws-ssm.sh deploy <sha>}"
    [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "not a git sha" >&2; exit 2; }
    run "/opt/dawai/bin/run-release.sh $sha" ;;
  extend) run "/opt/dawai/bin/extend-uptime.sh ${2:-120}" ;;
  seed)
    [ "${CONFIRM:-}" = "yes" ] || { echo "loads reference data into the PRODUCTION database. Re-run with CONFIRM=yes" >&2; exit 1; }
    run "cd /opt/dawai/releases/\$(cat /opt/dawai/CURRENT_SHA) && IMAGE_TAG=\$(cat /opt/dawai/CURRENT_SHA) docker compose -p dawai --env-file /opt/dawai/.env -f docker-compose.prod.yml --profile tools run --rm seed" ;;
  shell) exec aws ssm start-session --region "$REGION" --target "$ID" ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
