<!-- @format -->

# Basic auth CRUD

This example shows a small authenticated CRUD workflow with:

- HTTP basic auth
- a locally managed secret in `runmark/artifacts/secrets.yaml`
- JSON request bodies rendered from run inputs and prior step outputs
- a follow-up read that confirms the mutation

The checked-in `runmark/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `runmark/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. start `runmark demo start` in another terminal
2. create `runmark/artifacts/secrets.yaml` with your local password

```yaml
adminPassword: swordfish
```

## Run it

```bash
runmark validate --project-root examples/basic-auth-crud
runmark describe --run crud --project-root examples/basic-auth-crud
runmark run --run crud --project-root examples/basic-auth-crud
```
