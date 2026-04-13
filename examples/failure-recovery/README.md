<!-- @format -->

# Failure recovery

This example is intentionally shaped around a failed first run. It shows:

- a request that can fail before the run finishes
- request history captured for the failed attempt
- resuming the same session once the upstream dependency recovers

The checked-in `httpi/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `httpi/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. edit `httpi/env/dev.env.yaml` so `baseUrl` points at your service or mock server
2. run the recovery flow, inspect the failed session, then resume it after the upstream is healthy again

```bash
httpi validate --project-root examples/failure-recovery
httpi run --run recover-report --project-root examples/failure-recovery
httpi session show <sessionId> --project-root examples/failure-recovery
httpi artifacts list <sessionId> --project-root examples/failure-recovery
httpi resume <sessionId> --project-root examples/failure-recovery
```
