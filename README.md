# Runmark

<p>
  <a href="https://github.com/exit-zero-labs/runmark/actions/workflows/check.yml"><img alt="Check" src="https://img.shields.io/github/actions/workflow/status/exit-zero-labs/runmark/check.yml?branch=main&label=check&style=flat-square"></a>
  <a href="https://github.com/exit-zero-labs/runmark/actions/workflows/ci.yml"><img alt="Node compatibility" src="https://img.shields.io/github/actions/workflow/status/exit-zero-labs/runmark/ci.yml?branch=main&label=node%20compatibility&style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@exit-zero-labs/runmark"><img alt="npm version" src="https://img.shields.io/npm/v/%40exit-zero-labs%2Frunmark?label=npm&style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/exit-zero-labs/runmark?style=flat-square"></a>
</p>

`runmark` is a file-based HTTP workflow runner for repositories. It keeps tracked request intent in `runmark/`, git-ignored runtime state in `runmark/artifacts/`, and exposes the same execution model through a CLI and an MCP server — both shipped in a single binary.

Use it when API validation should live next to the code it exercises, with explicit runs, persisted artifacts, and pause/resume semantics that both humans and AI agents can inspect.

## Install

Use whichever install surface fits the repo you are working in:

### Global install

```bash
npm install -g @exit-zero-labs/runmark
runmark --version
```

### Repo-local / CI install

```bash
npm install --save-dev @exit-zero-labs/runmark
npx runmark --version
```

To update an existing global install:

```bash
npm install -g @exit-zero-labs/runmark@latest
runmark --version
```

- `runmark` — the CLI for humans and scripts.
- `runmark mcp` — the stdio MCP server for agents (same engine, same redaction, same artifacts).

If you chose the repo-local install above, prefix the commands below with `npx` (for example, `npx runmark init`). Global installs can use `runmark` directly.

```bash
mkdir demo-api && cd demo-api
runmark init
```

## What it solves

| Need | `runmark` |
| --- | --- |
| tracked request definitions | plain files under `runmark/` |
| multi-step API workflows | named runs with sequential, parallel, and pause-aware steps |
| inspectable execution evidence | persisted, redacted sessions and artifacts under `runmark/artifacts/` |
| one model for humans and agents | the same engine through the CLI and the MCP adapter |

## Quick start

After `init`, start the bundled demo API in another terminal and run:

```bash
runmark demo start
runmark validate
runmark describe --run smoke
runmark run --run smoke
```

`runmark init` gives you a small but real starting point: one environment, one request, one run, and schema-aware YAML files. The scaffolded `dev` env already points at the bundled demo server on `http://127.0.0.1:4318`, so you can reach first success before wiring your own service.

Typical output looks like this:

```json
{
  "rootDir": "/path/to/demo-api",
  "createdPaths": [
    "/path/to/demo-api/runmark/artifacts/.gitkeep",
    "/path/to/demo-api/runmark/artifacts/history/.gitkeep",
    "/path/to/demo-api/runmark/artifacts/sessions/.gitkeep",
    "/path/to/demo-api/runmark/config.yaml",
    "/path/to/demo-api/runmark/env/dev.env.yaml",
    "/path/to/demo-api/runmark/requests/ping.request.yaml",
    "/path/to/demo-api/runmark/runs/smoke.run.yaml",
    "/path/to/demo-api/.gitignore"
  ],
  "nextSteps": [
    "In another terminal: runmark demo start",
    "Then run: runmark run --run smoke"
  ]
}
```

`/path/to/demo-api` stands in for your actual absolute project path. The real `init` output also includes the runtime `.gitkeep` placeholders and the root `.gitignore`.

```json
{
  "rootDir": "./demo-api",
  "diagnostics": []
}
```

```json
{
  "session": {
    "sessionId": "run-<timestamp>-<id>",
    "state": "completed",
    "runId": "smoke",
    "artifactManifestPath": "runmark/artifacts/history/<sessionId>/manifest.json"
  },
  "diagnostics": []
}
```

What you should see:

- `init` prints created paths plus `nextSteps`.
- `validate` returns an empty `diagnostics` array.
- `run --run smoke` ends with `session.state: "completed"` and writes artifacts under `runmark/artifacts/history/<sessionId>/`.

If the flow needs local secrets, add them under `runmark/artifacts/secrets.yaml`:

```yaml
devPassword: swordfish
apiToken: sk_test_123
```

Tracked files can reference `{{secrets.alias}}` or `$ENV:NAME`, but secret literals should stay out of `runmark/`.

Session files that carry secret values are split on purpose:

- `runmark/artifacts/sessions/<sessionId>.json` keeps the inspectable session ledger with redacted placeholders.
- `runmark/artifacts/sessions/<sessionId>.secret.json` keeps the local secret companion state with owner-only permissions.
- `runmark audit export` never inlines the secret companion payload.
- `runmark clean` removes the main session file and its secret companion together.

The same JSON shape also makes pause, failure, and resume states easy to recognize:

```json
{
  "session": {
    "sessionId": "run-<timestamp>-<id>",
    "state": "paused",
    "nextStepId": "touch-user",
    "pausedReason": "Inspect fetched artifacts before mutation",
    "stepOutputs": {
      "login": { "sessionValue": "[REDACTED]" },
      "get-user": { "userName": "Ada" },
      "list-orders": { "firstOrderId": "ord_1" }
    }
  },
  "diagnostics": []
}
```

```json
{
  "session": {
    "sessionId": "run-<timestamp>-<id>",
    "state": "failed",
    "nextStepId": "fetch-report",
    "failureReason": "Assertion failed: status equals expected 200 but got 503."
  },
  "diagnostics": [
    {
      "code": "EXPECTATION_FAILED",
      "file": "runmark/requests/recovery/fetch-report.request.yaml",
      "line": 7,
      "message": "status equals: expected 200, got 503"
    }
  ]
}
```

```json
{
  "session": {
    "sessionId": "run-<timestamp>-<id>",
    "state": "completed",
    "runId": "smoke"
  },
  "diagnostics": []
}
```

Use [`docs/inspect-and-resume.md`](docs/inspect-and-resume.md) for the full pause/fail/resume loop, including artifact inspection and the exit-code-3 safety rules.

When a run pauses or fails, the next move stays explicit:

```bash
runmark session show <sessionId>
runmark artifacts list <sessionId>
runmark resume <sessionId>
```

## Project layout

`runmark` keeps the authored plan and the runtime evidence separate on purpose:

```text
demo-api/
└── runmark/
    ├── config.yaml
    ├── env/
    │   └── dev.env.yaml
    ├── requests/
    │   └── ping.request.yaml
    ├── runs/
    │   └── smoke.run.yaml
    └── artifacts/
        ├── secrets.yaml
        ├── sessions/
        └── history/
```

| Path | Purpose |
| --- | --- |
| `runmark/` | Git-tracked requests, runs, envs, blocks, body templates, and the git-ignored runtime subtree |
| `runmark/artifacts/` | Local secrets, session state, locks, and captured request artifacts |

In normal projects, `runmark/artifacts/` should stay Git-ignored apart from tracked `.gitkeep` placeholders. The checked-in examples in this repo include a small `runmark/artifacts/` skeleton so the runtime layout is easy to inspect.

## Secret storage

`runmark` keeps runtime secrets out of the shareable session ledger.

- Main session files store redacted placeholders so CLI output, MCP responses, and audit exports stay safe to inspect.
- Secret companion files live under `runmark/artifacts/sessions/*.secret.json` and should be treated as sensitive local runtime state in backup and retention policies.
- `runmark audit export` never includes companion-file contents.
- `runmark clean` removes session ledgers and companion files together.

## Operational properties

- **Validate before execution.** Catch schema, wiring, and safety issues before HTTP goes out.
- **Inspect before you mutate.** Use `describe` and `explain variables` to see what will happen ahead of time.
- **Pause on purpose.** Stop at meaningful checkpoints, inspect artifacts, then explicitly resume.
- **Redact by default.** Secret-bearing values stay hidden across CLI output, MCP responses, sessions, and artifact reads.
- **Resume safely.** `runmark` blocks unsafe resume when tracked definitions or `$ENV` inputs drift.

## Examples

All checked-in reference projects live under [`examples/`](examples/README.md), and they are exercised by the automated test suite.

| Example | Best for | What it shows |
| --- | --- | --- |
| [`examples/getting-started`](examples/getting-started) | first project setup | one env, one request, one run |
| [`examples/multi-env-smoke`](examples/multi-env-smoke) | environment-specific smoke checks | one run reused across `dev` and `staging` env files |
| [`examples/pause-resume`](examples/pause-resume) | understanding the full workflow | login, secret extraction, parallel reads, pause, artifact inspection, and resume |
| [`examples/api-key-body-file`](examples/api-key-body-file) | richer real-world request wiring | `$ENV` auth, body templates, run inputs, and step output chaining |
| [`examples/basic-auth-crud`](examples/basic-auth-crud) | local-secret auth plus mutable APIs | basic auth, JSON bodies, and sequential CRUD |
| [`examples/ecommerce-checkout`](examples/ecommerce-checkout) | product-style business workflows | carts, checkout, extracted IDs, and follow-up verification |
| [`examples/incident-runbook`](examples/incident-runbook) | operator runbooks | parallel diagnostics, pause, and safe resume before mutation |
| [`examples/failure-recovery`](examples/failure-recovery) | failure handling | failed sessions, history capture, and resume after recovery |

These examples are maintained reference projects with automated coverage behind them.

## CI and team adoption

`runmark` works well as a repo-local validation tool:

- install it as a dev dependency and call it through `npx runmark` / `pnpm exec runmark`
- keep tracked request intent under `runmark/` and keep `runmark/artifacts/` Git-ignored
- upload `runmark audit export`, `runmark/artifacts/history/`, reporter outputs, or selected redacted session ledgers when CI or reviewers need evidence
- never upload `runmark/artifacts/secrets.yaml` or `runmark/artifacts/sessions/*.secret.json`
- materialize local secrets from CI secrets or an external secret manager at runtime instead of committing them

Use these guides when the project moves beyond a single laptop:

- [`docs/ci-and-team-adoption.md`](docs/ci-and-team-adoption.md)
- [`docs/external-secret-sources.md`](docs/external-secret-sources.md)
- [`docs/error-codes.md`](docs/error-codes.md)

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

`runmark mcp` starts a stdio MCP server that exposes the same execution engine as the CLI — same redaction, same artifacts, same runtime model. Point any MCP client (Claude Desktop, Claude Code, Cursor, etc.) at the `runmark` bin with `mcp` as the first argument:

```json
{
  "mcpServers": {
    "runmark": {
      "command": "runmark",
      "args": ["mcp"]
    }
  }
}
```

If you don't want a global install, use `npx`:

```json
{
  "mcpServers": {
    "runmark": {
      "command": "npx",
      "args": ["-y", "@exit-zero-labs/runmark", "mcp"]
    }
  }
}
```

Because MCP servers are often configured globally, starting `runmark mcp` does **not** pick a project by server cwd. Every MCP tool call must include `projectRoot` pointing at the repository directory that contains `runmark/config.yaml`.

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
- `export_audit_summary`
- `clean_runtime_state` — supports dry-run, state filters, and retention flags

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `No runmark/config.yaml found...` | You are outside a project root. | Run `runmark init`, move into the project directory, or pass `--project-root`. |
| `validate` reports schema or YAML errors | A tracked file has the wrong shape or syntax. | Fix the reported file and rerun `validate`. |
| Requests cannot connect | `baseUrl` is wrong or the service is not running. | Start `runmark demo start` for the bundled local API, or update `runmark/env/*.env.yaml` to point at your service and retry. |
| Secrets lookup fails | `runmark/artifacts/secrets.yaml` is missing or incomplete. | Create or update the local secret alias. |
| `resume` exits with code `3` | Tracked definitions changed or another process still holds the session lock. | Retry after the lock clears; if definitions drifted, start a fresh run instead of forcing resume. |

## Trust and data handling

- `runmark` keeps tracked intent in `runmark/` and local runtime evidence in `runmark/artifacts/`.
- New scaffolds default to `responseBody: metadata` so first runs stay smaller and safer.
- Main session files stay inspectable and redacted; secret companions stay local in `*.secret.json`.
- `runmark clean` applies retention policies to terminal sessions, and `runmark audit export` produces a redacted handoff summary.
- `runmark` does not send product telemetry; network traffic comes from the requests and auth flows you configure.

For the full safety model, see:

- [`docs/security-and-privacy.md`](docs/security-and-privacy.md)
- [`docs/filesystem-safety.md`](docs/filesystem-safety.md)
- [`docs/unsafe-resume.md`](docs/unsafe-resume.md)

## Support

`runmark` is intended to be sustained by donations. GitHub Sponsors is the primary recurring path, and Open Collective is the secondary path for one-time support and public budget visibility:

- <https://github.com/sponsors/exit-zero-labs>
- <https://opencollective.com/exit-zero-labs>

See [`docs/support.md`](docs/support.md) for what donations fund and how the two support paths differ.

## Learn more

- [`docs/product.md`](docs/product.md) for the product framing
- [`docs/inspect-and-resume.md`](docs/inspect-and-resume.md) for the canonical paused / failed / resumed workflow
- [`docs/examples.md`](docs/examples.md) for the example catalog and recommended starting order
- [`docs/ci-and-team-adoption.md`](docs/ci-and-team-adoption.md) for GitHub Actions, PR review, and monorepo patterns
- [`docs/security-and-privacy.md`](docs/security-and-privacy.md) for storage, redaction, retention, and telemetry notes
- [`docs/yaml-reference.md`](docs/yaml-reference.md) for the tracked YAML field guide
- [`docs/cli-reference.md`](docs/cli-reference.md) for subcommand behavior and output conventions
- [`docs/outputs-and-runtime-files.md`](docs/outputs-and-runtime-files.md) for CLI/MCP JSON shapes plus runtime file layout
- [`docs/error-codes.md`](docs/error-codes.md) for exit codes and common diagnostic families
- [`docs/agent-guide.md`](docs/agent-guide.md) for CLI and MCP validation loops
- [`docs/support.md`](docs/support.md) for donation and sustainability notes
- [`CHANGELOG.md`](CHANGELOG.md) for user-visible release notes
- [`docs/get-started.md`](docs/get-started.md) for contributor setup and local development
