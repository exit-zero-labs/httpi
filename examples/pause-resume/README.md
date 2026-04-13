<!-- @format -->

# Pause and resume

This is the canonical full workflow example for `httpi`. It shows:

- a login request that extracts a secret token
- parallel read steps that consume the extracted value
- an explicit pause for inspection
- a safe resume into a mutating request

## Setup

1. edit `httpi/env/dev.env.yaml` so `baseUrl` points at your service or mock server
2. create `httpi/artifacts/secrets.yaml` with your local `devPassword`

```yaml
devPassword: swordfish
```

## Run it

```bash
httpi validate --project-root examples/pause-resume
httpi describe --run smoke --project-root examples/pause-resume
httpi run --run smoke --project-root examples/pause-resume
httpi session show <sessionId> --project-root examples/pause-resume
httpi artifacts list <sessionId> --project-root examples/pause-resume
httpi resume <sessionId> --project-root examples/pause-resume
```

The automated suites use this example as the canonical pause/resume flow, so it stays aligned with real CLI and MCP behavior.

The checked-in `httpi/artifacts/` files are `.gitkeep` placeholders so the runtime layout is visible in the repository without checking in real runtime values.
