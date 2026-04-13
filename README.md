# httpi

<p>
  <a href="https://github.com/exit-zero-labs/httpi/actions/workflows/check.yml"><img alt="Check" src="https://img.shields.io/github/actions/workflow/status/exit-zero-labs/httpi/check.yml?branch=main&label=check&style=flat-square"></a>
  <a href="https://github.com/exit-zero-labs/httpi/actions/workflows/ci.yml"><img alt="Node compatibility" src="https://img.shields.io/github/actions/workflow/status/exit-zero-labs/httpi/ci.yml?branch=main&label=node%20compatibility&style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@exit-zero-labs/httpi"><img alt="npm version" src="https://img.shields.io/npm/v/%40exit-zero-labs%2Fhttpi?label=npm&style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/exit-zero-labs/httpi?style=flat-square"></a>
</p>

`httpi` is a file-based HTTP workflow runner for repositories. It keeps tracked request intent in `httpi/`, local runtime state in `.httpi/`, and exposes the same execution model through a CLI and an MCP server — both shipped in a single binary.

Use it when API validation should live next to the code it exercises, with explicit runs, persisted artifacts, and pause/resume semantics that both humans and AI agents can inspect.

## Install

One package, two surfaces:

```bash
npm install -g @exit-zero-labs/httpi
```

- `httpi` — the CLI for humans and scripts.
- `httpi mcp` — the stdio MCP server for agents (same engine, same redaction, same artifacts).

```bash
mkdir demo-api && cd demo-api
httpi init
```

## What it solves

| Need | `httpi` |
| --- | --- |
| tracked request definitions | plain files under `httpi/` |
| multi-step API workflows | named runs with sequential, parallel, and pause-aware steps |
| inspectable execution evidence | persisted, redacted sessions and artifacts under `.httpi/` |
| one model for humans and agents | the same engine through the CLI and the MCP adapter |

## Quick start

After `init`, the normal first loop is:

```bash
# edit httpi/env/dev.env.yaml so baseUrl points at your service
httpi validate
httpi describe --run smoke
httpi run --run smoke
```

`httpi init` gives you a small but real starting point: one environment, one request, one run, and schema-aware YAML files.

If the flow needs local secrets, add them under `.httpi/secrets.yaml`:

```yaml
devPassword: swordfish
apiToken: sk_test_123
```

Tracked files can reference `{{secrets.alias}}` or `$ENV:NAME`, but secret literals should stay out of `httpi/`.

When a run pauses or fails, the next move stays explicit:

```bash
httpi session show <sessionId>
httpi artifacts list <sessionId>
httpi resume <sessionId>
```

## Project layout

`httpi` keeps the authored plan and the runtime evidence separate on purpose:

```text
demo-api/
├── httpi/
│   ├── config.yaml
│   ├── env/
│   │   └── dev.env.yaml
│   ├── requests/
│   │   └── ping.request.yaml
│   └── runs/
│       └── smoke.run.yaml
└── .httpi/
    ├── secrets.yaml
    ├── sessions/
    └── responses/
```

| Path | Purpose |
| --- | --- |
| `httpi/` | Git-tracked requests, runs, envs, blocks, and body templates |
| `.httpi/` | Local secrets, session state, locks, and captured artifacts |

In normal projects, `.httpi/` should stay local and untracked. The checked-in examples in this repo include a small `.httpi/` skeleton so the runtime layout is easy to inspect.

## Operational properties

- **Validate before execution.** Catch schema, wiring, and safety issues before HTTP goes out.
- **Inspect before you mutate.** Use `describe` and `explain variables` to see what will happen ahead of time.
- **Pause on purpose.** Stop at meaningful checkpoints, inspect artifacts, then explicitly resume.
- **Redact by default.** Secret-bearing values stay hidden across CLI output, MCP responses, sessions, and artifact reads.
- **Resume safely.** `httpi` blocks unsafe resume when tracked definitions or `$ENV` inputs drift.

## Examples

Public example projects live under [`examples/`](examples/README.md), and they are exercised by the automated test suite.

| Example | Best for | What it shows |
| --- | --- | --- |
| [`examples/getting-started`](examples/getting-started) | first project setup | one env, one request, one run |
| [`examples/pause-resume`](examples/pause-resume) | understanding the full workflow | login, secret extraction, parallel reads, pause, artifact inspection, and resume |
| [`examples/api-key-body-file`](examples/api-key-body-file) | richer real-world request wiring | `$ENV` auth, body templates, run inputs, and step output chaining |

These examples are maintained reference projects with automated coverage behind them.

## Core workflow

| Goal | Command |
| --- | --- |
| scaffold a project | `init` |
| discover requests, runs, envs, or sessions | `list` |
| validate before execution | `validate` |
| inspect a request or run shape | `describe` |
| inspect resolved values and provenance | `explain variables` |
| execute a request or run | `run` |
| inspect a paused or failed session | `session show` |
| inspect captured request/response evidence | `artifacts list` / `artifacts read` |
| continue a paused or failed workflow | `resume` |

## MCP server

`httpi mcp` starts a stdio MCP server that exposes the same project model as the CLI — same engine path, same redaction, same artifacts. Point any MCP client (Claude Desktop, Claude Code, Cursor, etc.) at the `httpi` bin with `mcp` as the first argument:

```json
{
  "mcpServers": {
    "httpi": {
      "command": "httpi",
      "args": ["mcp"]
    }
  }
}
```

If you don't want a global install, use `npx`:

```json
{
  "mcpServers": {
    "httpi": {
      "command": "npx",
      "args": ["-y", "@exit-zero-labs/httpi", "mcp"]
    }
  }
}
```

Registered tools:

- `list_definitions`
- `validate_project`
- `describe_request`
- `describe_run`
- `run_definition` — accepts exactly one of `requestId` or `runId`
- `resume_session`
- `get_session_state`
- `list_artifacts`
- `read_artifact`
- `get_stream_chunks`
- `cancel_session`
- `explain_variables`

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `No httpi/config.yaml found...` | You are outside a project root. | Run `httpi init`, move into the project directory, or pass `--project-root`. |
| `validate` reports schema or YAML errors | A tracked file has the wrong shape or syntax. | Fix the reported file and rerun `validate`. |
| Requests cannot connect | `baseUrl` is wrong or the service is not running. | Update `httpi/env/*.env.yaml` and retry. |
| Secrets lookup fails | `.httpi/secrets.yaml` is missing or incomplete. | Create or update the local secret alias. |
| `resume` exits with code `3` | Tracked definitions changed or another process still holds the session lock. | Retry after the lock clears; if definitions drifted, start a fresh run instead of forcing resume. |

## Support

`httpi` is intended to be sustained by donations. GitHub Sponsors is the primary recurring path, and Open Collective is the secondary path for one-time support and public budget visibility:

- <https://github.com/sponsors/exit-zero-labs>
- <https://opencollective.com/exit-zero-labs>

See [`docs/support.md`](docs/support.md) for what donations fund and how the two support paths differ.

## Learn more

- [`examples/README.md`](examples/README.md) for the full example catalog
- [`docs/agent-guide.md`](docs/agent-guide.md) for CLI and MCP validation loops
- [`docs/product.md`](docs/product.md) for the product framing
- [`docs/support.md`](docs/support.md) for donation and sustainability notes
- [`CHANGELOG.md`](CHANGELOG.md) for user-visible release notes
- [`docs/get-started.md`](docs/get-started.md) for local development, repo layout, and contributor workflows
