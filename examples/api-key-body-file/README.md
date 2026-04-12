<!-- @format -->

# API key and body file

This example shows a slightly richer request flow with:

- API-key auth sourced from `$ENV:API_TOKEN`
- a JSON request body loaded from `httpi/bodies/`
- run inputs flowing into the body template
- extracted step outputs feeding a follow-up request

The checked-in `.httpi/` directory is only there to show the runtime layout. Real projects should usually keep `.httpi/` untracked.

## Setup

1. edit `httpi/env/dev.env.yaml` so `baseUrl` points at your service or mock server
2. export `API_TOKEN`

```bash
export API_TOKEN=replace-me
httpi validate --project-root examples/api-key-body-file
httpi describe --run submit-order --project-root examples/api-key-body-file
httpi run --run submit-order --project-root examples/api-key-body-file
```

Use this example when you want a realistic single-run project without the pause/resume workflow.
