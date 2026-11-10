#!/usr/bin/env bash
# Every start gets a time limit (MAX_UPTIME_MIN from instance.env): a forgotten instance stops itself,
# so the monthly bill cannot run away. `instance_initiated_shutdown_behavior` is "stop", not "terminate".
set -euo pipefail
# shellcheck disable=SC1091
. /etc/dawai/instance.env
shutdown -h "+${MAX_UPTIME_MIN:-180}" "dawai: automatic stop (cost guard)"
