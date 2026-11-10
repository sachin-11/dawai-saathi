#!/usr/bin/env bash
# First boot only (cloud-init). Idempotent: running it again changes nothing that is already right.
# Amazon Linux 2023: SSM agent preinstalled, no SSH is configured, security updates are automatic.
set -euxo pipefail
# shellcheck disable=SC1091
. /etc/dawai/instance.env

dnf -y install docker jq dnf-automatic
# Automatic SECURITY updates.
sed -i 's/^upgrade_type.*/upgrade_type = security/; s/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer

# Docker Compose plugin (pinned, checksum verified).
COMPOSE_VERSION=v2.29.7
mkdir -p /usr/local/lib/docker/cli-plugins
if [ ! -x /usr/local/lib/docker/cli-plugins/docker-compose ]; then
  base="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}"
  arch="$(uname -m)" # x86_64 or aarch64: the release files use the same names
  curl -fsSL "$base/docker-compose-linux-${arch}" -o /tmp/docker-compose
  curl -fsSL "$base/docker-compose-linux-${arch}.sha256" -o /tmp/docker-compose.sha256
  (cd /tmp && sed "s#docker-compose-linux-${arch}#docker-compose#" docker-compose.sha256 | sha256sum -c -)
  install -m 0755 /tmp/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
fi

install -m 0644 /opt/dawai/boot/daemon.json /etc/docker/daemon.json
systemctl enable --now docker

# Swap: the AI service peaks above the RAM of a small instance.
if [ ! -f /swapfile ]; then
  fallocate -l "${SWAP_GB:-2}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon -a || true
sysctl -w vm.swappiness=20
printf 'vm.swappiness=20
vm.overcommit_memory=1
' > /etc/sysctl.d/90-dawai.conf
sysctl -w vm.overcommit_memory=1

# Journald must not fill the disk.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nMaxRetentionSec=1week\n' > /etc/systemd/journald.conf.d/dawai.conf
systemctl restart systemd-journald

# Units. dawai.service is enabled (every boot) but only deploys when a release exists.
install -m 0644 /opt/dawai/boot/*.service /opt/dawai/boot/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable dawai-dns.service dawai.service dawai-maxuptime.service dawai-backup.timer
systemctl start dawai-dns.service dawai-maxuptime.service dawai-backup.timer
systemctl start --no-block dawai.service
