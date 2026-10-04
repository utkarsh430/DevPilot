#!/usr/bin/env bash
# Idempotent installer for the DevPilot Local Claude Code Runner LaunchAgent.
# Safe to re-run: it unloads any existing copy, refreshes the plist, and reloads.

set -euo pipefail

LABEL="com.devpilot.runner"
PLIST_NAME="${LABEL}.plist"

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SRC_PLIST="${SCRIPT_DIR}/${PLIST_NAME}"

# Resolve the runner directory from this script's own location (repo root is two
# levels up from infra/launchd/). This is the launchd analogue of the systemd
# unit's `%h`-relative paths: no user's home is hardcoded in the committed template.
REPO_ROOT="$( cd -- "${SCRIPT_DIR}/../.." &> /dev/null && pwd )"
DEVPILOT_RUNNER_DIR="${REPO_ROOT}/apps/runner"

LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
DEST_PLIST="${LAUNCH_AGENTS_DIR}/${PLIST_NAME}"

LOG_DIR="${HOME}/.devpilot/logs"
OUT_LOG="${LOG_DIR}/runner.out.log"

if [[ ! -f "${SRC_PLIST}" ]]; then
    echo "ERROR: source plist not found at ${SRC_PLIST}" >&2
    exit 1
fi

echo "[install] ensuring log dir at ${LOG_DIR}"
mkdir -p "${LOG_DIR}"

echo "[install] ensuring LaunchAgents dir at ${LAUNCH_AGENTS_DIR}"
mkdir -p "${LAUNCH_AGENTS_DIR}"

echo "[install] unloading any existing ${LABEL} (ignore errors if not loaded)"
launchctl unload "${DEST_PLIST}" 2>/dev/null || true

# Legacy compat: hosts upgrading in place may still run the pre-rename unit.
# Remove it best-effort so the old and new runners never poll the queue together.
OLD_LABEL="com.ace.runner"
OLD_PLIST="${LAUNCH_AGENTS_DIR}/${OLD_LABEL}.plist"
echo "[install] removing legacy ${OLD_LABEL} unit if present (ignore errors if absent)"
launchctl bootout "gui/$(id -u)/${OLD_LABEL}" 2>/dev/null || true
launchctl unload "${OLD_PLIST}" 2>/dev/null || true
rm -f "${OLD_PLIST}"

echo "[install] rendering plist template to ${DEST_PLIST}"
echo "[install]   WorkingDirectory = ${DEVPILOT_RUNNER_DIR}"
echo "[install]   HOME             = ${HOME}"
if grep -q '__DEVPILOT_RUNNER_DIR__\|__HOME__' "${SRC_PLIST}"; then
    # Render the tokens with a literal substitution that XML-escapes each value
    # (the plist is XML) and never treats `&`, `#`, `<`, `>` or `\` in the path
    # as special. perl's `s/\Q..\E/$var/g` inserts $var verbatim, avoiding both
    # sed's `&` backreference and bash's patsub `&` expansion.
    DEVPILOT_RUNNER_DIR="${DEVPILOT_RUNNER_DIR}" HOME="${HOME}" perl -pe '
        BEGIN {
            sub xmlesc {
                my $s = shift;
                $s =~ s/&/&amp;/g;
                $s =~ s/</&lt;/g;
                $s =~ s/>/&gt;/g;
                return $s;
            }
            $rdir  = xmlesc($ENV{DEVPILOT_RUNNER_DIR});
            $rhome = xmlesc($ENV{HOME});
        }
        s/\Q__DEVPILOT_RUNNER_DIR__\E/$rdir/g;
        s/\Q__HOME__\E/$rhome/g;
    ' "${SRC_PLIST}" > "${DEST_PLIST}"
else
    # Already-rendered plist (no tokens) — copy as-is.
    cp "${SRC_PLIST}" "${DEST_PLIST}"
fi

echo "[install] loading ${LABEL}"
launchctl load -w "${DEST_PLIST}"

echo "[install] launchctl list entry:"
launchctl list | grep "${LABEL}" || echo "  (no entry found yet — give it a moment)"

echo "[install] waiting 3s for first log output..."
sleep 3

echo "[install] last 20 lines of ${OUT_LOG}:"
if [[ -f "${OUT_LOG}" ]]; then
    tail -n 20 "${OUT_LOG}"
else
    echo "  (no log yet at ${OUT_LOG})"
fi

echo "[install] done."
