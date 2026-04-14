<!-- @format -->

# Incident runbook

This example is an operator-style workflow that shows:

- header-based auth sourced from `$ENV:OPS_API_KEY`
- parallel diagnostic reads
- an explicit pause before any mutation
- a safe resume into a restart step that uses earlier diagnostics

The checked-in `runmark/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `runmark/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. start `runmark demo start` in another terminal
2. export `OPS_API_KEY`

```bash
export OPS_API_KEY=ops-token-secret
runmark validate --project-root examples/incident-runbook
runmark describe --run investigate-and-restart --project-root examples/incident-runbook
runmark run --run investigate-and-restart --project-root examples/incident-runbook
runmark resume <sessionId> --project-root examples/incident-runbook
```
