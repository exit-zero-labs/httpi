<!-- @format -->

# Ecommerce checkout

This example models a small checkout workflow with:

- API-key auth sourced from `$ENV:COMMERCE_API_TOKEN`
- body templates checked into `httpi/bodies/`
- extracted cart and order IDs
- a final verification request after checkout

The checked-in `httpi/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `httpi/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. edit `httpi/env/dev.env.yaml` so `baseUrl` points at your service or mock server
2. export `COMMERCE_API_TOKEN`

```bash
export COMMERCE_API_TOKEN=replace-me
httpi validate --project-root examples/ecommerce-checkout
httpi describe --run checkout --project-root examples/ecommerce-checkout
httpi run --run checkout --project-root examples/ecommerce-checkout
```
