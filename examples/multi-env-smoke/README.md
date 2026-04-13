<!-- @format -->

# Multi-env smoke

This example keeps one request and one run, but wires them to multiple environment files so the same smoke flow can target different deployments.

The checked-in `httpi/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `httpi/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. edit both files under `httpi/env/` so `baseUrl` points at the matching environment
2. run the smoke flow against the env you want

```bash
httpi validate --project-root examples/multi-env-smoke
httpi describe --run smoke --env staging --project-root examples/multi-env-smoke
httpi run --run smoke --env staging --project-root examples/multi-env-smoke
```
