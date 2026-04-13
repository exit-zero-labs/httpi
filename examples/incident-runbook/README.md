<!-- @format -->

# Incident runbook

This example is an operator-style workflow that shows:

- header-based auth sourced from `$ENV:OPS_API_KEY`
- parallel diagnostic reads
- an explicit pause before any mutation
- a safe resume into a restart step that uses earlier diagnostics

The checked-in `httpi/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `httpi/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. edit `httpi/env/dev.env.yaml` so `baseUrl` points at your service or mock server
2. export `OPS_API_KEY`

```bash
export OPS_API_KEY=replace-me
httpi validate --project-root examples/incident-runbook
httpi describe --run investigate-and-restart --project-root examples/incident-runbook
httpi run --run investigate-and-restart --project-root examples/incident-runbook
httpi resume <sessionId> --project-root examples/incident-runbook
```
