<!-- @format -->

# API key and body file

This example shows a slightly richer request flow with:

- API-key auth sourced from `$ENV:API_TOKEN`
- a JSON request body loaded from `runmark/bodies/`
- run inputs flowing into the body template
- extracted step outputs feeding a follow-up request

The checked-in `runmark/artifacts/` directory is only there to show the runtime layout. Real projects should usually keep `runmark/artifacts/` Git-ignored apart from the tracked `.gitkeep` placeholders.

## Setup

1. start `runmark demo start` in another terminal
2. export `API_TOKEN`

```bash
export API_TOKEN=api-token-secret
runmark validate --project-root examples/api-key-body-file
runmark describe --run submit-order --project-root examples/api-key-body-file
runmark run --run submit-order --project-root examples/api-key-body-file
```

Use this example when you want a realistic single-run project without the pause/resume workflow.
