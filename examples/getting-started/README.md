<!-- @format -->

# Getting started

This is the smallest complete `httpi` project in the repository: one environment, one request, and one run.

The checked-in `httpi/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `httpi/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. edit `httpi/env/dev.env.yaml` so `baseUrl` points at your service or mock server
2. run the starter flow

```bash
httpi validate --project-root examples/getting-started
httpi describe --run smoke --project-root examples/getting-started
httpi run --run smoke --project-root examples/getting-started
```

Use this example when you want a clean starting point without auth, secrets, or pause/resume behavior.
