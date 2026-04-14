<!-- @format -->

# YAML reference

This is the human-oriented field guide for the tracked files under `runmark/`.

Every tracked YAML file can include a `$schema` comment pointing at the published JSON Schema under `packages/contracts/schemas/`, but this page is meant to explain the fields in product terms.

## Core file layout

```text
runmark/
├── config.yaml
├── env/
│   └── <env>.env.yaml
├── requests/
│   └── <path>.request.yaml
├── runs/
│   └── <path>.run.yaml
├── blocks/
│   ├── headers/
│   └── auth/
└── bodies/
```

## Variable syntax

The tracked DSL uses a small number of interpolation forms:

| Form | Meaning |
| --- | --- |
| `{{baseUrl}}` | environment or config value |
| `{{secrets.devPassword}}` | local secret alias from `runmark/artifacts/secrets.yaml` |
| `{{steps.login.sessionValue}}` | extracted output from an earlier step |
| `$ENV:API_TOKEN` | process environment variable at execution time |

## `runmark/config.yaml`

Example:

```yaml
schemaVersion: 1
project: getting-started
defaultEnv: dev

defaults:
  timeoutMs: 5000

capture:
  requestSummary: true
  responseMetadata: true
  responseBody: metadata
```

Key fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | tracked-file schema version; currently `1` |
| `project` | human-readable project name |
| `defaultEnv` | env used when commands omit `--env` |
| `defaults.timeoutMs` | default request timeout for the project |
| `capture.requestSummary` | whether canonical request records are written |
| `capture.responseMetadata` | whether response status, headers, and metadata are kept |
| `capture.responseBody` | `metadata`, `full`, or `none` |
| `capture.maxBodyBytes` | upper limit for persisted body capture |
| `capture.redactHeaders` | headers redacted across runtime inspection surfaces |
| `redaction.*` | optional project-wide JSON-path or pattern-based redaction |

## `runmark/env/*.env.yaml`

Example:

```yaml
schemaVersion: 1
title: Development
values:
  baseUrl: http://127.0.0.1:4318
```

Key fields:

| Field | Meaning |
| --- | --- |
| `title` | optional human label |
| `values` | non-secret flat key/value map used by requests and runs |
| `guards.requireEnv` | optional environment-variable guard for sensitive envs |
| `guards.requireFlag` | optional CLI/MCP flag guard |
| `guards.blockParallelAbove` | cap for fan-out size in that env |
| `guards.blockIfBranchNotIn` | branch allow-list for risky environments |
| `guards.denyHosts` | hosts that should never be targeted from that env |

## `runmark/requests/*.request.yaml`

Simple request:

```yaml
kind: request
title: Ping
method: GET
url: "{{baseUrl}}/ping"
expect:
  status: 200
```

Richer request:

```yaml
kind: request
title: Login
method: POST
url: "{{baseUrl}}/auth/login"
uses:
  headers:
    - common/json
body:
  file: auth/login.json
  contentType: application/json
expect:
  status: 200
extract:
  sessionValue:
    from: $.token
    required: true
    secret: true
```

Key fields:

| Field | Meaning |
| --- | --- |
| `kind` | always `request` |
| `title` | optional display name |
| `method` | HTTP method |
| `url` | target URL with interpolation |
| `uses.headers` | reusable header blocks from `runmark/blocks/headers/` |
| `uses.auth` | reusable auth block from `runmark/blocks/auth/` |
| `defaults` | request-level default variables |
| `headers` | inline headers |
| `auth` | inline auth block (bearer, basic, header, OAuth2 client credentials, HMAC) |
| `body` | request body; supports `file`, `json`, `text`, `binary`, or `multipart` |
| `response.mode` | `buffered`, `stream`, or `binary` |
| `response.stream` | parser and capture settings for streamed responses |
| `response.saveTo` | project-relative path for saved responses |
| `expect` | status, latency, header, body, stream, or aggregate assertions |
| `extract` | JSONPath-based outputs promoted into later steps |
| `timeoutMs` | request-specific timeout override |
| `cancel` | cancellation behavior for signals or run timeouts |

### Body modes

`body` supports several forms:

| Form | When to use it |
| --- | --- |
| `file` | checked-in request templates under `runmark/bodies/` |
| `json` | short inline JSON payloads |
| `text` | raw text bodies |
| `kind: binary` | upload raw bytes from a file |
| `kind: multipart` | compose form-data parts from text, JSON, or files |

### Expectations

Common expectation fields:

| Field | Meaning |
| --- | --- |
| `expect.status` | exact status or list of allowed statuses |
| `expect.latencyMs` | lt/lte/gt/gte thresholds |
| `expect.headers` | exact, contains, startsWith, endsWith, regex, or exists checks |
| `expect.body.contentType` | content-type assertion |
| `expect.body.jsonPath` | JSONPath-based assertions |
| `expect.body.contains` | substring checks for text bodies |
| `expect.body.kind: json-schema` | validate against a tracked schema file |
| `expect.body.kind: snapshot` | snapshot-backed body assertion accepted through `runmark snapshot accept` |
| `expect.stream.*` | stream timing and assembled-payload checks |
| `expect.aggregate.*` | percentile and error-rate checks for iterated requests |

### Extraction

Each `extract` entry promotes a response value into later steps:

| Field | Meaning |
| --- | --- |
| `from` | JSONPath expression |
| `required` | fail the step if the value is missing |
| `secret` | redact the extracted output across session and CLI/MCP surfaces |

## `runmark/runs/*.run.yaml`

Simple run:

```yaml
kind: run
title: Smoke
env: dev
steps:
  - kind: request
    id: ping
    uses: ping
```

Pause-aware run:

```yaml
kind: run
title: Smoke
env: dev
steps:
  - kind: request
    id: login
    uses: auth/login
    with:
      password: "{{secrets.devPassword}}"

  - kind: parallel
    id: fetch-context
    steps:
      - kind: request
        id: get-user
        uses: users/get-user
      - kind: request
        id: list-orders
        uses: orders/list-orders

  - kind: pause
    id: inspect-after-fetch
    reason: Inspect fetched artifacts before mutation
```

Key fields:

| Field | Meaning |
| --- | --- |
| `kind` | always `run` |
| `title` | optional display name |
| `env` | default env for the run |
| `inputs` | default run inputs |
| `steps` | ordered workflow graph |
| `timeoutMs` | overall run timeout |
| `defaults.timeoutMs` | per-request default timeout for that run |
| `confirmation` | optional mutation gating rules |

### Step kinds

| Step kind | Meaning |
| --- | --- |
| `request` | execute one tracked request |
| `parallel` | fan out multiple request steps |
| `pause` | persist the session before the next step starts |
| `pollUntil` | repeat a request until a condition is met |
| `switch` | branch declaratively on a prior runtime value |

### Request steps inside runs

Request steps can add run-level execution behavior:

| Field | Meaning |
| --- | --- |
| `id` | stable step identifier used in logs and `{{steps.*}}` references |
| `uses` | tracked request ID to execute |
| `with` | step-specific variables |
| `retry` | retry policy with backoff, jitter, and retry conditions |
| `idempotency` | emitted idempotency header on retried requests |
| `iterate` | repeat the same request multiple times with optional concurrency |

## Reusable blocks

Request files can pull in shared tracked blocks:

- `runmark/blocks/headers/**/*.yaml` for reusable header sets
- `runmark/blocks/auth/**/*.yaml` for reusable auth definitions
- `runmark/bodies/**` for checked-in request payload files

Use blocks when the same headers, auth, or body templates appear in more than one request. Keep simple requests simple; do not over-normalize the first version of a workflow.
