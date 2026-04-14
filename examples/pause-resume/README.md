<!-- @format -->

# Pause and resume

This is the canonical full workflow example for `runmark`. It shows:

- a login request that extracts a secret token
- parallel read steps that consume the extracted value
- an explicit pause for inspection
- a safe resume into a mutating request

## Setup

1. start `runmark demo start` in another terminal
2. create `runmark/artifacts/secrets.yaml` with your local `devPassword`

```yaml
devPassword: swordfish
```

## Run it

```bash
runmark validate --project-root examples/pause-resume
runmark describe --run smoke --project-root examples/pause-resume
runmark run --run smoke --project-root examples/pause-resume
runmark session show <sessionId> --project-root examples/pause-resume
runmark artifacts list <sessionId> --project-root examples/pause-resume
runmark resume <sessionId> --project-root examples/pause-resume
```

The automated suites use this example as the canonical pause/resume flow, so it stays aligned with real CLI and MCP behavior.

The checked-in `runmark/artifacts/` files are `.gitkeep` placeholders so the runtime layout is visible in the repository without checking in real runtime values.
