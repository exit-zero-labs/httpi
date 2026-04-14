<!-- @format -->

# Multi-env smoke

This example keeps one request and one run, but wires them to multiple environment files so the same smoke flow can target different deployments.

The checked-in `runmark/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `runmark/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. start `runmark demo start` in another terminal
2. run the smoke flow against the env you want (the checked-in env files already point at the demo server)

```bash
runmark validate --project-root examples/multi-env-smoke
runmark describe --run smoke --env staging --project-root examples/multi-env-smoke
runmark run --run smoke --env staging --project-root examples/multi-env-smoke
```
