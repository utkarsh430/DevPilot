#!/usr/bin/env bash
# Install/refresh the DevPilot Local Claude Code Runner as a systemd --user unit.
# Idempotent: safe to re-run after editing devpilot-runner.service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/devpilot-runner.service"
UNIT_DST_DIR="$HOME/.config/systemd/user"
UNIT_DST="$UNIT_DST_DIR/devpilot-runner.service"
LOG_DIR="$HOME/.devpilot/logs"

if [ ! -f "$UNIT_SRC" ]; then
  echo "error: $UNIT_SRC not found" >&2
  exit 1
fi

echo "[devpilot-runner] preparing directories"
mkdir -p "$LOG_DIR" "$UNIT_DST_DIR"

echo "[devpilot-runner] installing unit -> $UNIT_DST"
cp "$UNIT_SRC" "$UNIT_DST"

# Legacy compat: hosts upgrading in place may still run the pre-rename unit.
# Remove it best-effort so the old and new runners never poll the queue together.
echo "[devpilot-runner] removing legacy ace-runner.service if present"
systemctl --user disable --now ace-runner.service 2>/dev/null || true
rm -f "$UNIT_DST_DIR/ace-runner.service"

# Linger lets the user manager run without an active login session,
# so the runner survives logoff and starts at boot.
echo "[devpilot-runner] enabling linger for $USER"
loginctl enable-linger "$USER"

echo "[devpilot-runner] reloading user systemd"
systemctl --user daemon-reload

echo "[devpilot-runner] enabling + starting devpilot-runner.service"
systemctl --user enable --now devpilot-runner.service

echo
echo "[devpilot-runner] status (last 20 lines):"
systemctl --user status devpilot-runner --no-pager --lines=20 || true
