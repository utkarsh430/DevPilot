#!/usr/bin/env bash
# Remove the DevPilot runner systemd --user unit. Leaves ~/.devpilot/logs intact.
set -euo pipefail

UNIT_DST="$HOME/.config/systemd/user/devpilot-runner.service"

echo "[devpilot-runner] stopping + disabling devpilot-runner.service"
systemctl --user disable --now devpilot-runner.service || true

if [ -f "$UNIT_DST" ]; then
  echo "[devpilot-runner] removing $UNIT_DST"
  rm -f "$UNIT_DST"
fi

echo "[devpilot-runner] reloading user systemd"
systemctl --user daemon-reload || true

echo "[devpilot-runner] done. Logs preserved at ~/.devpilot/logs/"
echo "  Note: linger is left enabled. To disable: loginctl disable-linger \"\$USER\""
