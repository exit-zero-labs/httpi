<!-- @format -->

# Outputs and runtime files

The CLI and MCP server share the same engine, which means they also share the same result shapes and runtime file layout.

## Output conventions

- most CLI commands print JSON
- `runmark list ...` prints tab-separated rows for shell-friendly discovery
- MCP tools return the same JSON payloads as the matching CLI commands
- `runmark run --reporter json[:path]` writes the same execution-result payload to disk

## Common JSON result shapes

| Surface | Top-level keys | Notes |
| --- | --- | --- |
| `init` | `rootDir`, `createdPaths`, `nextSteps` | scaffold summary |
| `validate` / `validate_project` | `rootDir`, `diagnostics` | no HTTP sent |
| `describe --request` / `describe_request` | `requestId`, `envId`, `request`, `variables`, `diagnostics` | compiled request |
| `describe --run` / `describe_run` | `runId`, `envId`, `title`, `steps`, `diagnostics` | simplified run graph |
| `run`, `resume`, `session show` / `run_definition`, `resume_session`, `get_session_state` | `session`, `diagnostics` | shared execution/session shape |
| `artifacts list` / `list_artifacts` | `sessionId`, `artifacts` | manifest entries only |
| `artifacts read` / `read_artifact` | `sessionId`, `relativePath`, `contentType`, `text` or `base64` | redacted read-back |
| `explain variables` / `explain_variables` | `targetId`, `envId`, `variables`, `diagnostics` | provenance without execution |
| `clean` / `clean_runtime_state` | `rootDir`, `dryRun`, `candidateSessionIds`, `removedSessionIds`, `keptSessionIds`, `skipped`, `removedPaths`, `removedReports`, `removedSecrets` | cleanup summary |
| `audit export` / `export_audit_summary` | `schemaVersion`, `generatedAt`, `rootDir`, `sessions` | redacted audit summary |

## Session result shape

The `session` object returned by `run`, `resume`, and `session show` is the main operator-facing execution ledger.

Important fields:

| Field | Meaning |
| --- | --- |
| `sessionId` | stable identifier for one execution |
| `runId` | tracked run or request ID |
| `envId` | effective environment |
| `state` | `created`, `running`, `paused`, `failed`, `completed`, or `interrupted` |
| `nextStepId` | next or failing step when applicable |
| `stepRecords` | per-step attempts, states, and artifact paths |
| `stepOutputs` | extracted outputs grouped by step |
| `artifactManifestPath` | path to `manifest.json` |
| `eventLogPath` | path to `events.jsonl` |
| `pausedReason` | reason for a paused run |
| `failureReason` | reason for a failed run |

## Artifact result shapes

Captured artifacts are summarized by manifest entries with these practical fields:

| Field | Meaning |
| --- | --- |
| `stepId` | step that produced the artifact |
| `attempt` | attempt number inside that step |
| `kind` | `request`, `body`, `stream.chunks`, `stream.assembled`, or `response.binary` |
| `relativePath` | path under `runmark/artifacts/history/<sessionId>/` |
| `contentType` | content type when known |
| `sha256` | checksum for binary-style captures |
| `size` / `sizeBytes` | artifact size when known |

## Runtime file layout

```text
runmark/artifacts/
├── secrets.yaml
├── reports/
│   └── run.json
├── sessions/
│   ├── <sessionId>.json
│   ├── <sessionId>.secret.json
│   ├── <sessionId>.lock
│   └── <sessionId>.cancel
└── history/
    └── <sessionId>/
        ├── manifest.json
        ├── events.jsonl
        └── steps/
            └── <stepId>/
                └── attempt-<n>/
                    ├── request.json
                    ├── body.json
                    ├── stream.chunks.json
                    ├── stream.assembled.json
                    └── response.bin
```

## What the runtime files mean

| Path | Meaning |
| --- | --- |
| `secrets.yaml` | local secret aliases used by tracked files |
| `reports/run.json` | optional reporter output from `run --reporter json` |
| `sessions/<sessionId>.json` | redacted, inspectable session ledger |
| `sessions/<sessionId>.secret.json` | local secret companion state |
| `sessions/<sessionId>.lock` | lock file used to prevent unsafe concurrent mutation |
| `sessions/<sessionId>.cancel` | cancellation marker written by `runmark cancel` |
| `history/<sessionId>/manifest.json` | index of captured artifacts for that session |
| `history/<sessionId>/events.jsonl` | structured lifecycle event log |
| `steps/*/request.json` | canonical captured request/response record for one attempt |
| `steps/*/body.json` | persisted response body when configured |
| `steps/*/stream.*` | streaming capture outputs when configured |
| `steps/*/response.bin` | binary response capture when configured |

## Sensitivity notes

- `sessions/<sessionId>.json` is safe to inspect because secret-bearing values are redacted
- `sessions/<sessionId>.secret.json` is sensitive local state and should not be shared
- response bodies and saved binaries may still contain non-secret business data even when headers and secret values are redacted
- `audit export` is the shareable summary when you want a safer handoff surface
