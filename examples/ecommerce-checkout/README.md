<!-- @format -->

# Ecommerce checkout

This example models a small checkout workflow with:

- API-key auth sourced from `$ENV:COMMERCE_API_TOKEN`
- body templates checked into `runmark/bodies/`
- extracted cart and order IDs
- a final verification request after checkout

The checked-in `runmark/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `runmark/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. start `runmark demo start` in another terminal
2. export `COMMERCE_API_TOKEN`

```bash
export COMMERCE_API_TOKEN=commerce-token-secret
runmark validate --project-root examples/ecommerce-checkout
runmark describe --run checkout --project-root examples/ecommerce-checkout
runmark run --run checkout --project-root examples/ecommerce-checkout
```
