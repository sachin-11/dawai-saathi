#!/usr/bin/env bash
# extend-uptime.sh [minutes]   (default 120) -- push the automatic shutdown further away.
set -euo pipefail
shutdown -c 2>/dev/null || true
shutdown -h "+${1:-120}" "dawai: automatic stop (cost guard)"
echo "the instance stops in ${1:-120} minutes"
