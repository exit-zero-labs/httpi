<!-- @format -->

# httpi - Agent Guide

This guide is for coding agents and MCP clients that need a reliable, inspectable way to validate HTTP workflows with `httpi`.

`httpi` is already documented thoroughly in [`README.md`](../README.md), [`product.md`](product.md), and [`architecture.md`](architecture.md). This document narrows that down to the execution loop agents most often need in practice.

## 1. Choose the surface

Use either:

- the **CLI** when you want shell commands and exit codes
- the **MCP adapter** when you want structured tool calls over stdio

Both surfaces use the same execution engine, the same session model, the same redaction policy, and the same pause/resume safety checks.

## 2. Recommended validation loop

The safest default loop for an agent is:

1. discover definitions
2. validate before execution
3. inspect the request or run shape
4. execute
5. inspect session state and artifacts
6. resume only when the next step is safe

CLI example:

```bash
httpi list runs
httpi validate
httpi describe --run smoke
httpi run --run smoke
httpi session show <sessionId>
httpi artifacts list <sessionId>
httpi artifacts read <sessionId> steps/login/attempt-1/request.summary.json
httpi resume <sessionId>
```

MCP equivalent:

| Intent | MCP tool |
| --- | --- |
| discover definitions | `list_definitions` |
| validate tracked files | `validate_project` |
| inspect one request | `describe_request` |
| inspect one run | `describe_run` |
| execute request or run | `run_definition` |
| inspect session state | `get_session_state` |
| list artifacts | `list_artifacts` |
| read artifact content | `read_artifact` |
| inspect resolved values | `explain_variables` |
| continue a paused or failed session | `resume_session` |

## 3. MCP tool constraints that matter

Two tool contracts are easy to misuse if you only skim the names:

1. `run_definition` accepts **exactly one** of `requestId` or `runId`
2. `explain_variables` accepts `requestId` or `runId`; when you use `runId`, `stepId` can narrow the explanation to a single run step

Safe examples:

```json
{ "name": "run_definition", "arguments": { "runId": "smoke", "projectRoot": "/repo" } }
```

```json
{ "name": "explain_variables", "arguments": { "runId": "smoke", "stepId": "login", "projectRoot": "/repo" } }
```

Unsafe example:

```json
{ "name": "run_definition", "arguments": { "requestId": "ping", "runId": "smoke" } }
```

## 4. How to inspect a paused or failed run

When `httpi` executes a run, it persists a session record and artifacts under `.httpi/`.

- `session show` / `get_session_state` tells you the session state, the failed or next step, and redacted step outputs
- `artifacts list` / `list_artifacts` shows which files were captured
- `artifacts read` / `read_artifact` lets you inspect one artifact with redaction applied

For the canonical pause flow, use the fixture project under [`testing/httpi/fixtures/basic-project`](../testing/httpi/fixtures/basic-project):

1. login
2. extract a token
3. fan out into parallel reads
4. pause at `inspect-after-fetch`
5. inspect artifacts
6. resume into the mutating step

That flow is pinned by:

- [`testing/httpi/httpi.e2e.test.mjs`](../testing/httpi/httpi.e2e.test.mjs)
- [`testing/httpi/judge/basic-flow.md`](../testing/httpi/judge/basic-flow.md)

## 5. What `[REDACTED]` means

`httpi` redacts secrets consistently across CLI output, MCP tool results, session JSON, and artifact reads.

When you see `[REDACTED]`, assume:

- the value exists in runtime state
- the value was intentionally hidden because it is secret-bearing or was extracted as secret output
- you should reason from the surrounding metadata instead of trying to recover the literal value

Useful signals that still remain visible:

- `stepId`
- `session.state`
- `nextStepId`
- whether a variable or output is marked secret
- request/response metadata after header redaction
- artifact paths and manifest entries

## 6. Handling drift and exit code 3

`httpi` blocks resume when tracked definitions drift or another process holds the session lock.

CLI exit codes:

- `0` success
- `1` execution or expectation failure
- `2` validation or configuration failure
- `3` unsafe resume or lock conflict
- `4` unexpected internal error

If you hit exit code `3`:

1. inspect the error details
2. determine whether tracked files changed or the session is currently locked
3. if tracked files drifted, start a fresh run instead of forcing resume
4. if the session is just locked, retry after the other process exits

## 7. Variable explanation tips

Use `explain variables` / `explain_variables` before execution when an agent needs to understand provenance without sending HTTP.

What to look for:

- `source` tells you whether a value came from env, run inputs, step overrides, defaults, or prior step output
- `secret` tells you whether the value should be treated as sensitive
- `steps.<stepId>.<field>` references show explicit dependency on earlier extracted values

This is especially useful before resume-aware workflows where later steps depend on login or bootstrap outputs.

## 8. When to trust the repo state

Treat:

- `httpi/` as the tracked source of truth
- `.httpi/` as the local runtime record of what already happened

That split is important for agents:

- tracked request and run definitions are reviewable and diffable
- session and artifact files are evidence, not authoring input
- `.httpi/secrets.yaml` must stay out of Git

## 9. Best next document

After this guide, the most useful references are:

- [`README.md`](../README.md) for the public quick start and troubleshooting flow
- [`architecture.md`](architecture.md) for execution semantics and package boundaries
- [`testing/httpi/README.md`](../testing/httpi/README.md) for fixture and judge assets
