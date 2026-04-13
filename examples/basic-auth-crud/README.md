<!-- @format -->

# Basic auth CRUD

This example shows a small authenticated CRUD workflow with:

- HTTP basic auth
- a locally managed secret in `httpi/artifacts/secrets.yaml`
- JSON request bodies rendered from run inputs and prior step outputs
- a follow-up read that confirms the mutation

The checked-in `httpi/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `httpi/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. edit `httpi/env/dev.env.yaml` so `baseUrl` points at your service or mock server
2. create `httpi/artifacts/secrets.yaml` with your local password

```yaml
adminPassword: swordfish
```

## Run it

```bash
httpi validate --project-root examples/basic-auth-crud
httpi describe --run crud --project-root examples/basic-auth-crud
httpi run --run crud --project-root examples/basic-auth-crud
```
