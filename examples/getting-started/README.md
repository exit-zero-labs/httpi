<!-- @format -->

# Getting started

This is the smallest complete `runmark` project in the repository: one environment, one request, and one run.

The checked-in `runmark/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `runmark/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. start `runmark demo start` in another terminal
2. run the starter flow (the checked-in `runmark/env/dev.env.yaml` already points at the demo server)

```bash
runmark validate --project-root examples/getting-started
runmark describe --run smoke --project-root examples/getting-started
runmark run --run smoke --project-root examples/getting-started
```

Use this example when you want a clean starting point without auth, secrets, or pause/resume behavior.
