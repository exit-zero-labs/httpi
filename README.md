# httpi

`httpi` is a file-based HTTP workflow runner for humans and AI agents. Keep reviewable request intent in `httpi/`, keep runtime evidence in `.httpi/`, and use the same execution model from the CLI or the MCP adapter.

## What it does

- validate request and run definitions before execution
- compose multi-step workflows with extraction, parallel steps, pause, and resume
- capture redacted request and response artifacts for inspection
- expose the same project model to shell users and MCP-compatible tools

## Install

| Surface | Package | Command |
| --- | --- | --- |
| CLI | `@exit-zero-labs/httpi` | `npm install -g @exit-zero-labs/httpi` |
| MCP stdio server | `@exit-zero-labs/httpi-mcp` | `npm install -g @exit-zero-labs/httpi-mcp` |

The shared `packages/*` workspace modules are internal implementation detail packages and are not meant to be installed directly.

## Quick start

```bash
npm install -g @exit-zero-labs/httpi
mkdir demo-api && cd demo-api

httpi init
# edit httpi/env/dev.env.yaml so baseUrl points at your service
httpi validate
httpi describe --run smoke
httpi run --run smoke
```

`httpi init` creates a starter project with a `ping` request, a `smoke` run, and schema-aware YAML files. When `--project-root` is omitted, the CLI discovers the nearest `httpi/config.yaml`.

If your workflow needs local secrets, create `.httpi/secrets.yaml`:

```yaml
devPassword: swordfish
apiToken: sk_test_123
```

Tracked files can reference `{{secrets.alias}}` or `$ENV:NAME`, but literal secrets should stay out of `httpi/`.

If a run pauses or fails, inspect and continue it with:

```bash
httpi session show <sessionId>
httpi artifacts list <sessionId>
httpi resume <sessionId>
```

## Core model

| Path | Purpose |
| --- | --- |
| `httpi/` | Git-tracked requests, runs, envs, blocks, and body templates |
| `.httpi/` | Local secrets, sessions, locks, and captured artifacts |

This split keeps authored intent reviewable while still preserving enough runtime evidence to inspect, debug, and safely resume runs.

## Example projects

Public example projects live under [`examples/`](examples/README.md) and are exercised by the automated test suite.

| Example | Highlights |
| --- | --- |
| [`examples/getting-started`](examples/getting-started) | smallest runnable project: one env, one request, one run |
| [`examples/pause-resume`](examples/pause-resume) | login, secret extraction, parallel reads, pause, artifact inspection, and explicit resume |
| [`examples/api-key-body-file`](examples/api-key-body-file) | `$ENV`-backed header auth, `body.file` templates, run inputs, and step output wiring |

## Command map

| Command | Use when |
| --- | --- |
| `init` | scaffold a working project |
| `list` | discover requests, runs, envs, or sessions |
| `validate` | catch schema, reference, and safety issues before execution |
| `describe` | inspect a request or run shape without sending HTTP |
| `explain variables` | inspect effective values and provenance before execution |
| `run` | execute one request or an entire run |
| `session show` | inspect a paused or failed session |
| `artifacts list` / `artifacts read` | inspect captured request and response artifacts |
| `resume` | continue a paused or failed session if drift checks pass |

## MCP adapter

`httpi-mcp` serves the same project model over stdio.

```json
{
  "command": "httpi-mcp",
  "args": []
}
```

Core tool parity:

| CLI command | MCP tool |
| --- | --- |
| `list` | `list_definitions` |
| `validate` | `validate_project` |
| `describe --request <id>` | `describe_request` |
| `describe --run <id>` | `describe_run` |
| `run --request <id>` / `run --run <id>` | `run_definition` |
| `resume <sessionId>` | `resume_session` |
| `session show <sessionId>` | `get_session_state` |
| `artifacts list <sessionId>` | `list_artifacts` |
| `artifacts read <sessionId> <relativePath>` | `read_artifact` |
| `explain variables ...` | `explain_variables` |

`run_definition` accepts exactly one of `requestId` or `runId`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `No httpi/config.yaml found...` | You are outside a project root. | Run `httpi init`, move into the project directory, or pass `--project-root`. |
| `validate` reports schema or YAML errors | A tracked file has the wrong shape or syntax. | Fix the reported file and rerun `validate`. |
| Requests cannot connect | `baseUrl` is wrong or the service is not running. | Update `httpi/env/*.env.yaml` and retry. |
| Secrets lookup fails | `.httpi/secrets.yaml` is missing or incomplete. | Create or update the secret alias locally. |
| `resume` exits with code `3` | Tracked definitions changed or another process still holds the session lock. | Retry after the lock clears; if definitions drifted, start a fresh run instead of forcing resume. |

## More docs

- [`examples/README.md`](examples/README.md) for the full example catalog
- [`docs/agent-guide.md`](docs/agent-guide.md) for CLI and MCP validation loops
- [`docs/product.md`](docs/product.md) for the product framing
- [`CHANGELOG.md`](CHANGELOG.md) for user-visible release notes
- [`docs/get-started.md`](docs/get-started.md) for local development, repo layout, and contributor workflows
