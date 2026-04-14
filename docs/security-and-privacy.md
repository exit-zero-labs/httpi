<!-- @format -->

# Security, privacy, and data handling

`runmark` is designed so the authored plan and the runtime evidence stay separate:

- `runmark/` contains tracked request intent
- `runmark/artifacts/` contains local runtime state and captured evidence

That split is the core of the tool's trust model.

## Safety model

`runmark` aims to be explicit rather than magical:

- tracked YAML files are the source of truth for what should happen
- CLI and MCP use the same execution engine, redaction rules, and runtime files
- pause/resume always goes through persisted session state instead of hidden in-memory state
- runtime paths stay within the project root and reject unsafe filesystem layouts

## What is stored locally

| Surface | Path | Sensitivity | Notes |
| --- | --- | --- | --- |
| tracked definitions | `runmark/` | shareable | requests, runs, env files, blocks, and body templates |
| local secret aliases | `runmark/artifacts/secrets.yaml` | sensitive | Git-ignored local or CI runtime file |
| main session ledger | `runmark/artifacts/sessions/<sessionId>.json` | inspectable | redacted placeholders instead of secret values |
| secret companion | `runmark/artifacts/sessions/<sessionId>.secret.json` | sensitive | local-only companion state used to restore secret inputs and outputs |
| artifact history | `runmark/artifacts/history/<sessionId>/` | mixed | request records, event log, manifest, bodies, binaries, and stream captures |
| JSON reports | `runmark/artifacts/reports/` | mixed | reporter output written by `run --reporter ...` |
| audit export | user-chosen output path inside the project | shareable | redacted session + artifact summary |

## What is redacted

By default, `runmark` redacts secret-bearing values across its main inspection surfaces:

- CLI output
- MCP tool responses
- main session ledgers
- artifact reads
- audit exports

Secret values are also split out of the main session ledger into `*.secret.json` companion files. New scaffolds default to `responseBody: metadata` so first runs do not capture full response bodies unless you opt in.

## What is not automatically redacted

`runmark` does **not** assume every captured value is a secret. These items can remain visible unless you narrow capture or configure extra redaction:

- non-secret extracted outputs such as IDs, counts, and names
- response bodies when you set `responseBody: full`
- files written through `response.saveTo`
- step IDs, request IDs, file paths, timestamps, and status codes

That means response capture policy is part of your privacy posture. Use `responseBody: metadata` when you only need status and headers, and reserve `full` for flows where you really need the body on disk.

## Telemetry

`runmark` does not send product telemetry or sync runtime state to a hosted service.

The network calls it makes come from:

- the HTTP requests you define
- auth/token flows you explicitly configure inside those requests

## Retention and cleanup

Runtime data accumulates locally until you delete it. Use `runmark clean` to apply retention policies to terminal sessions:

```bash
runmark clean --keep-last 10
runmark clean --state failed --older-than-days 14 --dry-run
runmark clean --reports --secrets
```

Use `runmark audit export` when you need a redacted handoff or review artifact:

```bash
runmark audit export --output runmark/artifacts/audit/latest.json
```

`runmark audit export` never inlines the secret companion payload.

## Recommended production posture

For local development, `runmark/artifacts/secrets.yaml` is a simple secret bridge. For CI and production-like automation, prefer:

- `$ENV:NAME` values injected by your automation platform
- an external secret manager that materializes `runmark/artifacts/secrets.yaml` just-in-time

See [`external-secret-sources.md`](external-secret-sources.md) for concrete patterns.

## Related safety docs

- [`filesystem-safety.md`](filesystem-safety.md) for path ownership, symlink rejection, and permissions
- [`unsafe-resume.md`](unsafe-resume.md) for lock conflicts, definition drift, and exit code `3`
- [`outputs-and-runtime-files.md`](outputs-and-runtime-files.md) for the runtime file layout and JSON result shapes
