#!/usr/bin/env bash
# Runs at EVERY boot (dawai-dns.service): the instance has no Elastic IP (it would cost ~$3.6/month even
# while stopped), so its public IP changes after each stop/start. It writes the current IP into the
# Route 53 zone with the instance role (route53:ChangeResourceRecordSets on that one zone only).
set -euo pipefail
# shellcheck disable=SC1091
. /etc/dawai/instance.env

token() { curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 120'; }
ip=""
for _ in $(seq 1 30); do
  ip="$(curl -fsS -H "X-aws-ec2-metadata-token: $(token)" http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
  [ -n "$ip" ] && break
  sleep 2
done
[ -n "$ip" ] || { echo "dns-update: no public IPv4 yet" >&2; exit 1; }

batch="$(jq -n --arg ip "$ip" --arg a "$DOMAIN" --arg b "$API_DOMAIN" --argjson ttl "${DNS_TTL:-60}" '{
  Comment: "dawai boot",
  Changes: [$a, $b] | map({Action: "UPSERT", ResourceRecordSet: {Name: ., Type: "A", TTL: $ttl, ResourceRecords: [{Value: $ip}]}})
}')"
aws route53 change-resource-record-sets --region "$AWS_REGION" --hosted-zone-id "$ZONE_ID" --change-batch "$batch" >/dev/null
echo "dns-update: $DOMAIN and $API_DOMAIN -> $ip"
