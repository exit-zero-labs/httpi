# httpi

`httpi` is an open-source, Git-tracked HTTP workflow runner for humans and AI agents. It keeps request intent in `httpi/`, runtime state in `.httpi/`, and exposes the same execution model through a CLI and an MCP server.

## Status

`httpi` now includes a working v0 implementation:

- shared definition, runtime, HTTP, and execution packages
- a thin CLI adapter in `apps/cli`
- a thin MCP stdio server in `apps/mcp`
- persisted sessions and artifacts under `.httpi/`
- pause/resume execution for run files
- end-to-end fixtures and tests under `testing/httpi/`

`httpi` is intentionally narrow: it is optimized for file-based, reviewable, agent-inspectable HTTP workflows inside a repository. It is **not** trying to be a GUI-first collection manager or cloud workspace replacement.

## Why teams reach for it

`httpi` is designed for real API iteration work:

- define requests and runs in readable project files
- keep intent in Git and runtime state out of Git
- pause and resume workflows intentionally
- capture artifacts for inspection and comparison
- let humans and MCP-compatible agents reason about the same execution model

## Where it fits best

`httpi` is strongest when you want API validation to live next to the code it exercises.

- use Git as the source of truth for request intent instead of a GUI collection
- let a human or coding agent inspect artifacts before continuing a workflow
- share one engine across shell automation and MCP-based tooling
- keep secrets local while still making runtime outcomes easy to inspect

If you mainly want a GUI-first API client with cloud sync and visual collections, a GUI-first tool may be a better fit today. `httpi` is intentionally optimized for file-based, reviewable workflows.

## Documentation

- [`docs/product.md`](docs/product.md) - high-level product overview
- [`docs/architecture.md`](docs/architecture.md) - current technical architecture
- [`docs/agent-guide.md`](docs/agent-guide.md) - agent-oriented CLI/MCP usage patterns and pause/resume guidance
- [`docs/roadmap.md`](docs/roadmap.md) - current near-term priorities and guardrails
- [`CHANGELOG.md`](CHANGELOG.md) - user-visible release notes for the current 0.1.x line
- [`docs/archive-architecture.md`](docs/archive-architecture.md) - preserved first draft
- [`docs/idea.md`](docs/idea.md) - original idea and motivation
- [`CONTRIBUTING.md`](CONTRIBUTING.md) - contributor workflow and scope guidance
- [`testing/httpi/README.md`](testing/httpi/README.md) - fixture, e2e, and judge asset guide

## Repository layout

```text
apps/        CLI and MCP entrypoints
packages/    shared engine packages
docs/        product and architecture documents
testing/     fixtures, flows, and judge-oriented validation assets
```

## Local commands

```bash
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm check
```

## Install from npm

The public npm install surface is intentionally small:

- `@exit-zero-labs/httpi` - CLI package with the `httpi` binary
- `@exit-zero-labs/httpi-mcp` - MCP stdio adapter with the `httpi-mcp` binary

The shared engine packages remain internal workspace implementation details and are not meant to be installed directly.

Install the CLI globally with:

```bash
npm install -g @exit-zero-labs/httpi
httpi init
```

Install the MCP adapter globally with:

```bash
npm install -g @exit-zero-labs/httpi-mcp
httpi-mcp
```

## Quick start

```bash
pnpm install
pnpm build

node apps/cli/dist/index.js init
node apps/cli/dist/index.js validate
node apps/cli/dist/index.js describe --run smoke
node apps/cli/dist/index.js explain variables --request ping
node apps/cli/dist/index.js run --run smoke
```

`init` writes a starter project with a `dev` environment, a `ping` request, and a `smoke` run so the initial validate/describe/explain/run flow works immediately.

### Next steps after `init`

The starter scaffold is intentionally minimal. After the first `validate`/`describe` pass, the usual next steps are:

1. edit `httpi/env/dev.env.yaml` so `baseUrl` points at the service or mock server you actually want to exercise
2. rerun `describe` or `explain variables` before execution when you change env values or inputs
3. create `.httpi/secrets.yaml` for any local-only credentials your own requests need
4. inspect `testing/httpi/fixtures/basic-project` when you want a fuller example with auth, extraction, parallel reads, pause, and resume

Example local secrets file:

```yaml
devPassword: swordfish
apiToken: sk_test_123
```

### Confirm the scaffold worked

Expected checkpoints on a clean starter project:

The `createdPaths` values will be absolute paths on your machine. The snippets below shorten them with `.../` so the structure is easier to scan.

```json
{
  "createdPaths": [".../httpi/config.yaml", ".../httpi/env/dev.env.yaml", ".../httpi/requests/ping.request.yaml", ".../httpi/runs/smoke.run.yaml"]
}
```

```json
{
  "diagnostics": []
}
```

```json
{
  "runId": "smoke",
  "steps": [
    { "id": "ping", "kind": "request", "requestId": "ping" }
  ]
}
```

The CLI discovers the nearest `httpi/config.yaml`, reads tracked definitions from `httpi/`, and writes runtime state to `.httpi/`.

Documented exit codes stay stable in the 0.1.x line:

- `0` success
- `1` execution or expectation failure
- `2` validation or configuration error
- `3` unsafe resume or lock conflict
- `4` unexpected internal error

Recovery guide:

| Exit code or state | Meaning | Inspect first | Safe next step |
| --- | --- | --- | --- |
| `0` | The run completed successfully. | `session show` or `artifacts list` only if you want to review the evidence. | No recovery needed. |
| `1` and `session.state = failed` | A request ran and then failed its execution or expectation checks. | `session show <sessionId>` for `failureReason` and the failed step, then `artifacts list/read` for request/response evidence. | Fix the underlying service, env, or secret issue and `resume <sessionId>` to retry the failed step. |
| `2` | Validation or configuration failed before safe execution. | `validate` output, plus the reported file and line. | Fix the tracked file, config, or missing secret, rerun `validate`, then run again. |
| `3` | Resume is unsafe because tracked files drifted, or another process holds the session lock. | Stderr details for changed files or lock conflicts. | Retry once the lock clears; if definitions drifted, start a fresh run instead of resuming. |
| `4` | An unexpected internal error occurred. | Stderr JSON details, then `session show` and `artifacts` if a session was persisted. | Preserve the evidence, file an issue, and rerun only after you understand whether the prior attempt reached the remote system. |

This recovery model is intentionally operator-driven: `httpi` persists enough evidence to inspect and explicitly resume safe cases, but it does not auto-retry or guess through ambiguous delivery.

If a run pauses, inspect and continue it with:

```bash
node apps/cli/dist/index.js session show <sessionId>
node apps/cli/dist/index.js artifacts list <sessionId>
node apps/cli/dist/index.js resume <sessionId>
```

`paused` sessions continue at `nextStepId`, `failed` sessions retry the failed step, and `interrupted` sessions are diagnostic-only in v0 and should be restarted from a fresh run.

## Minimal project shape

The starter workflow stays intentionally small:

```yaml
# httpi/requests/ping.request.yaml
kind: request
title: Ping
method: GET
url: "{{baseUrl}}/ping"
expect:
  status: 200
```

```yaml
# httpi/runs/smoke.run.yaml
kind: run
title: Smoke
env: dev
steps:
  - kind: request
    id: ping
    uses: ping
```

When you want a fuller example than the one-request starter, inspect [`testing/httpi/fixtures/basic-project`](testing/httpi/fixtures/basic-project). It shows the intended v0 workflow shape: authenticate, extract a secret value, fan out into parallel reads, pause for inspection, then resume into a mutation step.

## Command map

| Command | Use when |
| ------- | -------- |
| `init` | scaffold a working `httpi/` project and `.httpi/` runtime directory |
| `list` | discover requests, runs, envs, or sessions |
| `validate` | catch schema, reference, and safety issues before execution |
| `describe` | inspect a request or run shape without sending HTTP |
| `explain variables` | inspect effective values and provenance before execution |
| `run` | execute one request or an entire run |
| `session show` | inspect a paused or failed session and its next step |
| `artifacts list` / `artifacts read` | inspect captured request and response artifacts |
| `resume` | continue a paused or failed session if drift checks pass |

## Editor support

The repo ships JSON Schema files under `packages/contracts/schemas/` and maps them in `.vscode/settings.json` for contributors editing this repository.

`init` also writes `yaml-language-server` schema comments into the starter `config`, `env`, `request`, and `run` files so generated projects get inline validation and autocomplete without extra local wiring.

## MCP workflow

To start the MCP adapter over stdio after building:

```bash
node apps/mcp/dist/index.js
```

If you install the published package globally, the same adapter is available as:

```bash
httpi-mcp --help
httpi-mcp
```

The core tool surface mirrors the CLI flow:

| CLI command | MCP tool | Purpose |
| --- | --- | --- |
| `list` | `list_definitions` | discover requests, runs, envs, and persisted sessions |
| `validate` | `validate_project` | return structured diagnostics before execution |
| `describe --request <id>` | `describe_request` | resolve one request without sending it |
| `describe --run <id>` | `describe_run` | compile one run and inspect its step graph |
| `run --request <id>` / `run --run <id>` | `run_definition` | execute exactly one request or one run |
| `resume <sessionId>` | `resume_session` | continue a paused or failed session after drift checks |
| `session show <sessionId>` | `get_session_state` | inspect persisted state, drift info, and next step |
| `artifacts list <sessionId>` | `list_artifacts` | enumerate captured request/response artifacts |
| `artifacts read <sessionId> <relativePath>` | `read_artifact` | read one artifact with the same redaction policy as the CLI |
| `explain variables ...` | `explain_variables` | inspect effective values and provenance |

Two MCP-specific notes matter for agent clients:

1. `run_definition` accepts **either** `requestId` **or** `runId`, not both.
2. `explain_variables` accepts `requestId` or `runId`; when you use `runId`, `stepId` can narrow the explanation to one run step.

Recommended agent loop:

1. `list_definitions` to discover the available requests, runs, envs, and sessions
2. `validate_project` before any execution attempt
3. `describe_run` or `describe_request` to inspect what will happen
4. `run_definition` to execute, then `get_session_state` if the run pauses or fails
5. `list_artifacts` and `read_artifact` to inspect evidence before any mutating step continues
6. `resume_session` only after the artifacts and session state look safe to continue

For a worked agent-oriented example, see [`docs/agent-guide.md`](docs/agent-guide.md).

## Local secrets

Runtime-only secrets belong in `.httpi/secrets.yaml`, which should stay out of Git:

```yaml
devPassword: swordfish
apiToken: sk_test_123
```

Tracked request and run files can reference these values with `{{secrets.alias}}`. The same interpolation model also works in body templates under `httpi/bodies/`.

For CI or ephemeral environments, write `.httpi/secrets.yaml` at runtime or provide the needed values through the supported `$ENV:NAME` secret references. Keep the tracked `httpi/` files free of secret literals either way.

## What works today

The current v0 surface already covers:

- request and run discovery, validation, and execution
- `describe` and `explain variables` inspection before execution
- persisted sessions plus artifact listing and reading
- explicit pause/resume with drift checks
- the same core workflow through CLI and MCP

## v0.1.x stability note

The current 0.1.x line is intended to keep the following baseline stable while the project is still pre-1.0:

- tracked file layout under `httpi/` and runtime layout under `.httpi/`
- request and run validation semantics
- the `describe`, `explain variables`, `run`, `session`, `artifacts`, and `resume` workflow
- the shared execution model across CLI and MCP

Roadmap work in `docs/roadmap.md` is meant to clarify and extend this baseline, not replace it silently.

User-visible changes in that baseline are tracked in [`CHANGELOG.md`](CHANGELOG.md).

## Troubleshooting

When something goes wrong, start with the smallest inspection surface that matches the failure:

1. **Definition or schema error**: run `validate` and fix the reported file and line.
2. **Unexpected request shape**: run `describe` and `explain variables` before executing.
3. **Paused or failed run**: run `session show <sessionId>` to inspect the state and next step.
4. **Need request/response evidence**: run `artifacts list <sessionId>` and `artifacts read <sessionId> <relativePath>`.
5. **Resume blocked by drift**: start a fresh run if tracked files changed after the session was created.

Common first-run fixes:

| Error or symptom | Likely cause | Fix |
| --- | --- | --- |
| `No httpi/config.yaml found... Run httpi init first.` | You are outside a scaffolded project root. | Run `httpi init`, then rerun the command from that directory or pass `--project-root`. |
| `validate` reports YAML parse errors | Hand-edited YAML has indentation, quoting, or shape issues. | Fix the reported file and line, then rerun `validate` before `run`. |
| `baseUrl` is empty or requests fail to connect | The target service is not running or the env value points at the wrong host/port. | Check `httpi/env/*.env.yaml`, start the service or mock server, then rerun `describe` or `run`. |
| `resume` says the session is locked | Another `httpi` process is still writing that session, or a prior run crashed before lock cleanup. | Wait for the other process to exit. If you confirm the prior process is gone, remove `.httpi/sessions/<sessionId>.lock` and retry. |
| Secrets lookup fails | `.httpi/secrets.yaml` is missing or does not define the referenced key. | Create or update `.httpi/secrets.yaml` with the expected secret name, then rerun `validate`. |
| The mock server fails to start | Another process is already using the configured port. | Stop the conflicting process or change the port in your env file and restart the server. |
| A run does nothing | The run file has no steps or points at the wrong request IDs. | Open `httpi/runs/*.run.yaml`, add steps, and confirm the referenced definitions with `describe run`. |

For a full fixture-backed reference flow, inspect `testing/httpi/fixtures/basic-project`, `testing/httpi/httpi.e2e.test.mjs`, and `testing/httpi/judge/basic-flow.md`.
