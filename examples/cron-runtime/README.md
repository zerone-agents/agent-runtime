# Cron runtime example

Start the runtime (cron scheduler starts before HTTP listens):

```bash
zerone-agent --config examples/cron-runtime
```

Manage tasks from another terminal (online CLI talks to the running server; it
never opens the cron files itself):

```bash
zerone-agent cron create --name "Daily summary" --cron "0 18 * * *" \
  --prompt "Summarize today's work" --agent assistant --json
zerone-agent cron list --json
zerone-agent cron run <task-id> --json      # 202 Accepted, execution continues in background
zerone-agent cron history --task <task-id> --json
```

Task state and execution history persist under `examples/cron-runtime/.zerone/cron/`.
Stop with Ctrl-C — the runtime drains active executions for `drainMs`, then releases the lock.
