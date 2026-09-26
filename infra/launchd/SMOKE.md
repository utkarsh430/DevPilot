# SMOKE — com.devpilot.runner LaunchAgent

```
launchctl list | grep devpilot.runner          # PID non-dash = running; exit code 0 last run
tail -f ~/.devpilot/logs/runner.out.log        # expect: [devpilot-runner] registered: <uuid>
tail -f ~/.devpilot/logs/runner.err.log        # should be quiet
pgrep -fl tsx                             # expect a tsx process under apps/runner
launchctl print gui/$(id -u)/com.devpilot.runner | head -40   # state + last exit reason
```

Auto-restart check (kill tsx and watch launchd respawn it within ~10s, the ThrottleInterval):

```
pkill -f 'tsx --env-file=../web/.env.local' ; sleep 12 ; pgrep -fl tsx
```
