# DevPilot Runner systemd smoke test

Assumes repo is cloned at `~/code/devpilot/`. If you cloned elsewhere, edit `WorkingDirectory=` in `devpilot-runner.service` and re-run `install.sh`.

1. Install: `bash infra/systemd/install.sh`
2. Status: `systemctl --user status devpilot-runner`
3. Tail logs: `journalctl --user -u devpilot-runner -f` (or `tail -f ~/.devpilot/logs/runner.out.log`)
4. Look for line: `[devpilot-runner] registered: <uuid>` — proves engine handshake worked.
5. Crash test: `systemctl --user kill -s SIGKILL devpilot-runner` then re-check status; PID should change within ~5s (Restart=always, RestartSec=5).
6. Reboot test: `sudo reboot`; after login, `systemctl --user status devpilot-runner` should be `active (running)` (linger enables boot-time start without an active session).
7. Update unit: edit `devpilot-runner.service`, then re-run `bash infra/systemd/install.sh` (idempotent — copies + daemon-reloads + restarts).
8. Uninstall: `bash infra/systemd/uninstall.sh` (logs preserved at `~/.devpilot/logs/`).
