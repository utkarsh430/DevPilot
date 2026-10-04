#!/usr/bin/env bash
# Uninstall the DevPilot Local Claude Code Runner LaunchAgent.
# Leaves ~/.devpilot/logs/ in place so you can inspect prior runs.

set -euo pipefail

LABEL="com.devpilot.runner"
PLIST_NAME="${LABEL}.plist"
DEST_PLIST="${HOME}/Library/LaunchAgents/${PLIST_NAME}"

if [[ -f "${DEST_PLIST}" ]]; then
    echo "[uninstall] unloading ${LABEL}"
    launchctl unload "${DEST_PLIST}" 2>/dev/null || true

    echo "[uninstall] removing ${DEST_PLIST}"
    rm -f "${DEST_PLIST}"
else
    echo "[uninstall] no plist at ${DEST_PLIST}; nothing to remove"
    # Still try to unload by label in case it was loaded from elsewhere.
    launchctl remove "${LABEL}" 2>/dev/null || true
fi

echo "[uninstall] logs preserved at ${HOME}/.devpilot/logs/"
echo "[uninstall] done."
