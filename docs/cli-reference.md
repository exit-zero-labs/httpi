<!-- @format -->

# CLI reference

`runmark` ships one CLI surface plus one MCP surface. This page covers the CLI commands. For the shared JSON result shapes and runtime file layout, use [`outputs-and-runtime-files.md`](outputs-and-runtime-files.md).

## Global conventions

- `runmark help <command>` and `<command> --help` route to the same help topics
- `--project-root <path>` points commands at a repo containing `runmark/config.yaml`
- JSON is the default output format for most commands
- `runmark list ...` is the main exception: it prints tab-separated rows for easy shell use

## Discovery and inspection

| Command | Purpose | Output |
| --- | --- | --- |
| `runmark list <requests|runs|envs|sessions>` | list tracked definitions or persisted sessions | tab-separated rows |
| `runmark validate` | parse and wire-check tracked files without sending HTTP | JSON `{ rootDir, diagnostics }` |
| `runmark describe --request <id>` | compile one request without executing it | JSON `{ requestId, envId, request, variables, diagnostics }` |
| `runmark describe --run <id>` | compile one run into a simplified step graph | JSON `{ runId, envId, title, steps, diagnostics }` |
| `runmark explain variables ...` | show effective values plus provenance and secret marking | JSON `{ targetId, envId, variables, diagnostics }` |

## Execution and control

| Command | Purpose | Output |
| --- | --- | --- |
| `runmark demo start` | start the bundled local demo API | long-running server process |
| `runmark run --request <id>` | execute one request | JSON `{ session, diagnostics }` |
| `runmark run --run <id>` | execute one full run | JSON `{ session, diagnostics }` |
| `runmark cancel <sessionId>` | request graceful cancellation | JSON cancel result |
| `runmark resume <sessionId>` | continue a paused or failed session after safety checks | JSON `{ session, diagnostics }` |
| `runmark snapshot accept <sessionId> --step <stepId>` | update a snapshot-backed request from the latest captured response body | JSON acceptance result |

### `runmark run` reporter

`runmark run` accepts `--reporter json[:path]`.

- `json` with no path writes to `runmark/artifacts/reports/run.json`
- `json:<path>` writes to a project-relative output path you choose
- the reporter payload is the same execution-result shape that the command prints to stdout

## Runtime inspection

| Command | Purpose | Output |
| --- | --- | --- |
| `runmark session show <sessionId>` | inspect the persisted session ledger and drift diagnostics | JSON `{ session, diagnostics }` |
| `runmark artifacts list <sessionId>` | list artifact manifest entries for one session | JSON `{ sessionId, artifacts }` |
| `runmark artifacts read <sessionId> <relativePath>` | read one captured artifact with redaction applied | JSON `{ sessionId, relativePath, contentType, text|base64 }` |

## Runtime lifecycle and audit

| Command | Purpose | Output |
| --- | --- | --- |
| `runmark clean` | remove terminal runtime state without touching tracked files | JSON cleanup summary |
| `runmark audit export` | export a redacted session-and-artifact summary | JSON audit summary |

### `runmark clean`

Important flags:

| Flag | Meaning |
| --- | --- |
| `--session <id>` | clean one specific session |
| `--state <completed|failed|interrupted>` | limit cleanup to selected terminal states |
| `--keep-last <n>` | preserve the newest matching sessions |
| `--older-than-days <n>` | only remove older matching sessions |
| `--reports` | also remove `runmark/artifacts/reports/` |
| `--secrets` | also remove `runmark/artifacts/secrets.yaml` |
| `--dry-run` | show what would be removed without mutating anything |

Defaults:

- cleanable states are `completed`, `failed`, and `interrupted`
- `created`, `running`, and `paused` sessions are preserved
- matching cleanup also removes local `*.secret.json` companion files

### `runmark audit export`

Important flags:

| Flag | Meaning |
| --- | --- |
| `--session <id>` | export one session instead of the whole project |
| `--output <path>` | write the summary to a project-relative file |

Audit export always remains redacted. Secret companion files stay local runtime state and are never inlined into the exported payload.

## MCP server

`runmark mcp` starts the stdio MCP server backed by the same engine as the CLI.

Important rules:

- every tool call must include `projectRoot`
- MCP clients upgraded to the current surface must send `projectRoot` on every tool call
- the tool inventory includes lifecycle commands such as `clean_runtime_state` and `export_audit_summary`

For the recommended CLI/MCP validation loop, use [`agent-guide.md`](agent-guide.md).

## Exit codes

The important process exit codes are:

| Exit code | Meaning |
| --- | --- |
| `0` | success |
| `1` | execution or assertion failure |
| `2` | validation or configuration failure |
| `3` | unsafe resume or lock conflict |
| `4` | unexpected internal error |

Use [`error-codes.md`](error-codes.md) for the common diagnostic and error families behind those exits.
