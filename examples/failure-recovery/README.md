<!-- @format -->

# Failure recovery

This example is intentionally shaped around a failed first run. It shows:

- a request that can fail before the run finishes
- request history captured for the failed attempt
- resuming the same session once the upstream dependency recovers

The checked-in `runmark/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `runmark/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. start `runmark demo start` in another terminal
2. run the recovery flow, inspect the failed session, then resume it after the upstream is healthy again

```bash
runmark validate --project-root examples/failure-recovery
runmark run --run recover-report --project-root examples/failure-recovery
runmark session show <sessionId> --project-root examples/failure-recovery
runmark artifacts list <sessionId> --project-root examples/failure-recovery
runmark resume <sessionId> --project-root examples/failure-recovery
```
