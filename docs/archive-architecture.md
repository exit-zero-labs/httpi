<!-- @format -->

# httpi - Archived Architecture Draft (v0)

**Status**: Archived draft  
**Date**: 2026-04-11  
**Basis**: `docs/idea.md` and multi-persona review feedback

---

This document preserves the first full architecture pass for `httpi`.

- For the current user-facing overview, see [`product.md`](product.md).
- For the current technical source of truth, see [`architecture.md`](architecture.md).

## 1. Purpose

`httpi` is a file-based HTTP client, CLI, and MCP project for defining, running, pausing, resuming, and inspecting HTTP request workflows from a Git-tracked repo.

This v0 architecture is intentionally narrow:

- **requests** are the primary building blocks
- **runs** orchestrate sequential, parallel, and pause behavior
- **runtime artifacts** live in a Git-ignored directory for human and AI inspection
- **CLI and MCP** share one strictly typed engine

The goal is not to design every future feature up front. The goal is to define the smallest architecture that satisfies the idea doc while staying modular, readable, resumable, and safe.

## 2. v0 Outcomes

v0 is successful if it delivers the following outcomes.

1. A developer can create one env file, one request file, and one run file, then validate and execute them in a few minutes from a terminal.
2. An AI agent can discover the same files, run them through MCP, inspect the resulting artifacts, and resume an interrupted session without relying on hidden state.
3. Request execution is deterministic enough to support LLM-as-a-judge workflows: session IDs, step IDs, artifacts, and events are stable and inspectable.
4. Secrets stay out of tracked files, and runtime artifacts are redacted and isolated by default.
5. The implementation path is obvious for a new contributor in the current pnpm turborepo scaffold.

### Golden-path mental model

Most users should only need:

- `httpi/env/`
- `httpi/requests/`
- `httpi/runs/`

Everything else is optional power-user or reuse-oriented structure.

## 3. Design Principles

1. **Request-first authoring**: request files are the main unit humans and AI agents read and write.
2. **Runs own orchestration**: sequencing, parallelism, and pause points live in run files, not in separate orchestration concepts.
3. **Tracked intent, untracked runtime**: `httpi/` defines behavior; `.httpi/` stores local artifacts, sessions, and secrets.
4. **Optional reuse, not mandatory ceremony**: reusable header/auth blocks and body files exist, but simple requests stay simple.
5. **Strict typing at every boundary**: files, compiled runtime models, events, artifacts, and interface payloads all have runtime schemas and TypeScript types.
6. **One engine, many interfaces**: CLI and MCP are adapters over the same execution core.
7. **Explainable state**: variable resolution, extracted values, pause reasons, and artifact paths must be inspectable.
8. **Safe defaults over magical behavior**: no embedded scripts, no implicit secret storage in tracked files, no ambiguous resume semantics.
9. **Internal extensibility, conservative surface area**: keep the code modular without inflating the v0 user model.

## 4. Canonical User Journeys

### 4.1 First 5 minutes

The golden-path project can start with only four tracked files:

```text
httpi/
├── config.yaml
├── env/
│   └── dev.env.yaml
├── requests/
│   └── ping.request.yaml
└── runs/
    └── smoke.run.yaml
```

Expected flow:

1. `httpi init`
2. `httpi validate`
3. `httpi run --run smoke --env dev`

This path should work without creating `blocks/`, `bodies/`, or `.httpi/secrets.yaml`.

Minimal worked example:

`httpi/env/dev.env.yaml`

```yaml
schemaVersion: 1
values:
  baseUrl: http://localhost:3000
```

`httpi/requests/ping.request.yaml`

```yaml
kind: request
method: GET
url: "{{baseUrl}}/health"

expect:
  status: 200
```

`httpi/runs/smoke.run.yaml`

```yaml
kind: run
env: dev

steps:
  - kind: request
    id: ping
    uses: ping
```

### 4.2 Login -> extract -> parallel reads -> pause -> resume

The main power-user flow from the idea doc is:

1. authenticate
2. extract token or IDs from the login response
3. fan out into parallel reads
4. pause for inspection
5. resume into mutating requests

v0 must treat this as a first-class scenario, not an edge case.

Full worked-example file set:

- `httpi/requests/auth/login.request.yaml`
- `httpi/requests/users/get-user.request.yaml`
- `httpi/requests/orders/list-orders.request.yaml`
- `httpi/requests/users/update-user.request.yaml`
- `httpi/runs/user-debug.run.yaml`

Expected lifecycle:

1. `login` extracts an auth token
2. `get-user` and `list-orders` run in parallel using `{{steps.login.authToken}}`
3. `inspect-after-fetch` pauses and persists the session
4. `httpi resume <sessionId>` continues with `update-user` using the same compiled snapshot

### 4.3 Failed validation after code changes

When a user or AI agent changes the API under test, `httpi` should make it easy to:

1. run the same flow again
2. inspect previous artifacts
3. compare outcomes manually
4. decide whether to start a new run or safely resume an existing session

### 4.4 AI judge flow

An AI agent should be able to:

1. list definitions
2. describe a run before executing it
3. execute the run
4. inspect artifacts and session state
5. determine pass/fail from structured metadata and captured bodies

## 5. Scope and Non-Goals

### In scope for v0

- YAML-based tracked definitions
- request files with inline or file-based bodies
- reusable header and auth blocks
- run files with `request`, `parallel`, and `pause` step kinds
- persisted sessions for pause/resume
- deterministic artifact capture in `.httpi/`
- one CLI app and one MCP app over shared packages
- test fixtures and agent-validation docs under `testing/`
- runtime validation schemas for definitions, sessions, artifacts, events, and interface payloads

### Out of scope for v0

- GUI or desktop app
- cloud sync or hosted workspace concepts
- separate sequence file types
- external plugin marketplace
- browser-based OAuth/OIDC flows
- external secret managers
- importers from Postman, Bruno, or OpenAPI
- generalized automatic retry orchestration

## 6. High-Level Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ Interfaces                                                  │
│  apps/cli                apps/mcp               │
└──────────────────────┬──────────────────────┬───────────────┘
                       │                      │
                       └──────────┬───────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│ Shared engine packages                                       │
│                                                              │
│  definitions -> execution -> runtime                         │
│        │             │            │                          │
│        └─────────────┴─────┬──────┘                          │
│                            ▼                                 │
│                           http                               │
│                                                              │
│  contracts + shared utilities                                │
└──────────────────────────────────────────────────────────────┘
                 │                                 │
                 ▼                                 ▼
        tracked project files              untracked runtime state
              `httpi/`                          `.httpi/`
```

Core idea:

- `httpi/` is the tracked source of truth
- `.httpi/` is the local execution surface
- the engine compiles definitions into an execution snapshot
- CLI and MCP expose the same lifecycle, result, and artifact model

## 7. Monorepo Layout

The repository is already scaffolded as a pnpm turborepo. v0 should keep the package graph small and explicit.

| Path                   | Responsibility                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/cli`             | Human-facing CLI entrypoint, console rendering, exit codes                                                |
| `apps/mcp`             | MCP server entrypoint and tool adapters                                                                   |
| `packages/contracts`   | Public engine-facing schemas, events, result payloads, and interface DTOs consumed by CLI, MCP, and tests |
| `packages/definitions` | YAML parsing, validation, project discovery, identity/reference resolution                                |
| `packages/http`        | HTTP transport, auth application, body encoding, request execution                                        |
| `packages/runtime`     | Session persistence, locking, artifact writing, resume safety                                             |
| `packages/execution`   | Run compilation, scheduling, variable resolution, orchestration                                           |
| `packages/shared`      | Small leaf utilities with no HTTP, runtime, execution, or definition semantics                            |

### Package rules

- `apps/*` may depend on packages but not on each other
- `packages/contracts` defines only public payloads that cross package or interface boundaries
- `packages/execution` may depend on `definitions`, `http`, `runtime`, `contracts`, and `shared`
- `packages/http` must not know about CLI or MCP concerns
- `packages/runtime` owns on-disk formats and locking rules for `.httpi/`
- `packages/shared` is a leaf-only utility package; domain logic must not accumulate there

### 7.1 Package ownership matrix

| Package                | Owns                                                                                | Must not own                                                   |
| ---------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/contracts`   | public DTOs, JSON schemas, lifecycle events, session/result payloads                | file IO, YAML parsing, HTTP transport, business logic          |
| `packages/definitions` | project discovery, path-derived IDs, YAML loading, validation, reference resolution | scheduling, artifact writing, CLI rendering                    |
| `packages/http`        | request execution, body encoding, auth application, transport concerns              | session persistence, run scheduling, interface payload shaping |
| `packages/runtime`     | sessions, locks, manifests, artifacts, redaction-aware persistence                  | YAML parsing, scheduling policy, console/MCP presentation      |
| `packages/execution`   | run compilation, variable resolution, orchestration, pause/resume behavior          | low-level HTTP transport details, console formatting           |
| `packages/shared`      | generic leaf helpers like path, hash, fs, or collection utilities                   | domain models, execution policy, validation rules              |

### 7.2 Workspace rules

- all workspace packages should be private until there is a deliberate publishing plan
- each package should expose explicit exports rather than relying on deep imports
- TypeScript project references should mirror package dependency directions
- Turbo tasks should at minimum include `build`, `typecheck`, `test`, and `lint`
- forbidden dependency directions should be enforced by review and later automation:
  - apps cannot depend on apps
  - `contracts` cannot depend on domain packages
  - `definitions`, `http`, and `runtime` must not depend on `execution`
  - `shared` must not depend on any domain package

## 8. Project File Model

### 8.1 Tracked and untracked directories

```text
repo/
├── httpi/
│   ├── config.yaml
│   ├── env/
│   │   └── dev.env.yaml
│   ├── blocks/
│   │   ├── auth/
│   │   └── headers/
│   ├── bodies/
│   ├── requests/
│   └── runs/
├── .httpi/
│   ├── responses/
│   ├── sessions/
│   └── secrets.yaml
└── testing/
    └── httpi/
        ├── fixtures/
        ├── flows/
        └── judge/
```

### 8.2 File types

| Path                               | Purpose                                            |
| ---------------------------------- | -------------------------------------------------- |
| `httpi/config.yaml`                | Project defaults, capture policy, redaction policy |
| `httpi/env/*.env.yaml`             | Named environment values                           |
| `httpi/blocks/headers/**/*.yaml`   | Reusable header blocks                             |
| `httpi/blocks/auth/**/*.yaml`      | Reusable auth blocks                               |
| `httpi/bodies/**`                  | Reusable body payload files                        |
| `httpi/requests/**/*.request.yaml` | Atomic request definitions                         |
| `httpi/runs/**/*.run.yaml`         | Execution plans                                    |
| `.httpi/secrets.yaml`              | Local secret aliases, Git-ignored                  |
| `.httpi/sessions/*.json`           | Persisted session snapshots                        |
| `.httpi/responses/<sessionId>/...` | Captured runtime artifacts                         |

Only `config.yaml`, `env/`, `requests/`, and `runs/` are required in the minimal v0 project. `blocks/` and `bodies/` are optional and only exist when the project needs reuse.

All tracked YAML formats and runtime JSON/JSONL artifacts must carry an explicit `schemaVersion` in v0. For JSONL files such as `events.jsonl`, each event object carries its own `schemaVersion`.

### 8.3 Identity and references

Canonical identity is always derived from file paths, not from a field inside the file.

- request ID = path under `httpi/requests/` without `.request.yaml`
- run ID = path under `httpi/runs/` without `.run.yaml`
- env ID = path under `httpi/env/` without `.env.yaml`
- header block ID = path under `httpi/blocks/headers/` without `.yaml`
- auth block ID = path under `httpi/blocks/auth/` without `.yaml`

Tracked definition files may include optional `title`, but not `name` as an identity field.

Examples:

- `httpi/requests/users/get-user.request.yaml` -> `users/get-user`
- `httpi/runs/smoke.run.yaml` -> `smoke`
- `httpi/env/dev.env.yaml` -> `dev`
- `httpi/blocks/headers/common/json-defaults.yaml` -> `common/json-defaults`

Reference rules:

- request definitions use `uses` for reusable blocks
- run steps use `uses` for referenced requests
- step IDs must be unique across the compiled run
- extracted values are referenced explicitly as `{{steps.<stepId>.<field>}}`

### 8.4 Scaffold rules

`httpi init` must:

1. create `httpi/config.yaml`
2. create `httpi/env/`, `httpi/requests/`, and `httpi/runs/`
3. add `.httpi/` to `.gitignore`
4. avoid creating optional directories unless the user asks for examples

`httpi init --example` may create blocks, bodies, and sample flows.

## 9. Core Data Model

### 9.1 Project config

`httpi/config.yaml` defines project-level defaults and safety policies.

Example:

```yaml
schemaVersion: 1
project: my-api
defaultEnv: dev

defaults:
  timeoutMs: 10000

capture:
  requestSummary: true
  responseMetadata: true
  responseBody: full # full | metadata-only | never
  maxBodyBytes: 1048576
  redactHeaders:
    - authorization
    - cookie
    - set-cookie
    - x-api-key
  redactJsonPaths:
    - $.password
    - $.token
    - $.accessToken
```

Config is for defaults and policies, not workflow logic.

### 9.2 Environment files

Environment files contain non-secret values that vary by environment.

Example:

```yaml
schemaVersion: 1
title: Local development
values:
  baseUrl: http://localhost:3000
  apiVersion: v1
```

### 9.3 Secrets file

`.httpi/secrets.yaml` is optional and local-only.

Example:

```yaml
schemaVersion: 1
aliases:
  serviceToken:
    fromEnv: SERVICE_TOKEN
  localApiKey:
    value: sk-local-123
```

Rules:

- tracked files must not contain secret literals
- literal local secrets are allowed only in `.httpi/secrets.yaml`
- `.httpi/secrets.yaml` must be owner-readable only where the OS supports it
- tracked files may reference secrets via `{{secrets.<alias>}}` or direct `$ENV:NAME`

### 9.4 Reusable blocks

v0 has two first-class reusable block kinds:

- `headers`
- `auth`

**Headers block**

```yaml
kind: headers
title: JSON defaults
headers:
  Accept: application/json
  Content-Type: application/json
```

**Auth block**

```yaml
kind: auth
title: Service token
scheme: bearer
token: "{{secrets.serviceToken}}"
```

### 9.5 Request definitions

Request files are the primary authoring surface.

Example:

```yaml
kind: request
title: Get user

method: GET
url: "{{baseUrl}}/api/{{apiVersion}}/users/{{userId}}"

uses:
  headers:
    - common/json-defaults

auth:
  scheme: bearer
  token: "{{authToken}}"

params:
  include: profile,settings

expect:
  status: 200

extract:
  userName:
    from: $.name
    required: true
  userEmail:
    from: $.email

capture:
  sensitive: false
```

Example with a file-based body:

```yaml
kind: request
title: Create user

method: POST
url: "{{baseUrl}}/api/{{apiVersion}}/users"

uses:
  headers:
    - common/json-defaults

body:
  type: json
  file: users/create-user.json
```

Request rules:

- a request defines one HTTP interaction
- `title` is optional; identity comes from file path
- a request may use reusable blocks and still define inline headers/auth/body
- body files are resolved relative to `httpi/bodies/`
- request definitions are pure data; v0 does not support embedded scripts

#### Merge and precedence rules

- referenced header blocks merge in listed order
- if multiple header blocks define the same header, the later block wins
- header names are compared case-insensitively and normalized internally
- inline request headers override all block-derived headers
- a request may define either inline `auth` or `uses.auth`, but not both
- body definitions are always request-local in v0; there are no body blocks

#### Expectation semantics

v0 expectation behavior must be explicit:

- `expect.status` is an exact HTTP status integer
- failed expectations mark the step as `failed`
- even on expectation failure, response artifacts are still written when a response exists

#### Extraction semantics

v0 extraction behavior must be explicit:

- `from` is a JSONPath expression against a JSON response body
- `required: true` means missing extraction fails the step
- omitted `required` means the value is optional and may be absent
- extracted values preserve JSON types
- if extraction is configured and the response body is not valid JSON, the step fails
- extracted values are stored under `steps.<stepId>.<field>`
- extracted values are never implicitly promoted into the flat variable namespace
- extracted values may be marked `sensitive: true`; such values are redacted in events, session summaries, and metadata

### 9.6 Run definitions

Run files are the only orchestration artifact in v0.

Example:

```yaml
kind: run
title: User debug
env: dev

inputs:
  userId: "123"

steps:
  - kind: request
    id: login
    uses: auth/login
    with:
      email: dev@example.com
      password: "{{secrets.devPassword}}"

  - kind: parallel
    id: fetch-context
    steps:
      - kind: request
        id: get-user
        uses: users/get-user
        with:
          authToken: "{{steps.login.authToken}}"
      - kind: request
        id: list-orders
        uses: orders/list-orders
        with:
          authToken: "{{steps.login.authToken}}"

  - kind: pause
    id: inspect-after-fetch
    reason: Inspect artifacts before mutating data

  - kind: request
    id: update-user
    uses: users/update-user
    with:
      authToken: "{{steps.login.authToken}}"
      userName: Alice
```

Step kinds in v0:

- `request`
- `parallel`
- `pause`

Run rules:

- run IDs come from file paths
- request steps reference request IDs under `httpi/requests/`
- `with` values are step-local overrides merged into the flat request variable namespace
- `parallel` child steps run concurrently and join before the parent group completes
- `pause` persists session state and exits cleanly
- `pause` steps are only valid in the top-level sequential flow in v0; pauses inside parallel groups are invalid
- nested runs are out of scope for v0

## 10. Runtime Model

### 10.1 Compiled run snapshot

Tracked YAML is for authoring. Execution runs against a compiled snapshot.

The compiled snapshot must include:

- schema version
- run ID and env ID
- fully resolved definition references
- normalized step graph
- definition hashes for all referenced tracked files
- capture and redaction policy effective for the run

The snapshot is created once at run start and stored with the session.

Frozen at run start:

- tracked definitions and their resolved references
- environment values
- run-level inputs
- request defaults
- capture and redaction policy
- schema versions

Late-bound at step attempt time:

- direct `$ENV:NAME` reads
- `.httpi/secrets.yaml` alias resolution

This means resume uses the original compiled snapshot for project data, but still resolves secrets at the moment a not-yet-started step executes.

### 10.2 Sessions

Sessions are first-class runtime objects.

Each session records:

- `sessionId`
- `runId`
- `envId`
- `state`
- `nextStepId`
- compiled snapshot reference and definition hashes
- flat input variable values in effect
- step-scoped extracted values and provenance
- per-step status and attempt counts
- artifact paths
- timestamps
- pause or failure reason when relevant

Example:

```json
{
  "schemaVersion": 1,
  "sessionId": "sess_01HXYZ",
  "runId": "user-debug",
  "envId": "dev",
  "state": "paused",
  "nextStepId": "update-user",
  "pauseReason": "Inspect artifacts before mutating data",
  "definitionHashes": {
    "runs/user-debug": "sha256:...",
    "requests/auth/login": "sha256:..."
  }
}
```

Sessions are stored in `.httpi/sessions/<sessionId>.json`.

### 10.3 Session state machine

Session states:

- `created`
- `running`
- `paused`
- `failed`
- `completed`
- `interrupted`

Rules:

- `created -> running`
- `running -> paused | failed | completed | interrupted`
- `paused -> running` only through explicit resume
- `failed -> running` only through explicit resume or replay
- `interrupted` means the process exited during a running step and the engine cannot assume whether the request reached the server

Step states:

- `pending`
- `running`
- `completed`
- `failed`
- `paused`
- `interrupted`

Session transition table:

| From      | To            | Trigger                                             |
| --------- | ------------- | --------------------------------------------------- |
| `created` | `running`     | run starts                                          |
| `running` | `paused`      | pause step commits                                  |
| `running` | `failed`      | request, expectation, or extraction failure commits |
| `running` | `completed`   | final step commits successfully                     |
| `running` | `interrupted` | process exits before terminal step commit           |
| `paused`  | `running`     | explicit resume succeeds                            |
| `failed`  | `running`     | explicit resume succeeds                            |

Step transition table:

| From      | To            | Trigger                                               |
| --------- | ------------- | ----------------------------------------------------- |
| `pending` | `running`     | step attempt begins                                   |
| `running` | `completed`   | request, expect, extract, and artifact commit succeed |
| `running` | `failed`      | request, expect, or extract produces terminal failure |
| `running` | `interrupted` | process exits before terminal commit                  |
| `running` | `paused`      | only for explicit pause nodes                         |

### 10.4 Variable resolution

Interpolation syntax is `{{name}}` or `{{steps.<stepId>.<field>}}`.

Flat variable precedence, highest to lowest:

1. CLI or MCP invocation overrides
2. step-level `with` values
3. run-level `inputs`
4. request-local defaults
5. selected environment values
6. project config defaults

Important rule:

- extracted values are not part of the flat precedence chain
- they are referenced explicitly through `steps.<stepId>.<field>`

This keeps provenance clear and prevents silent collisions.

Authoritative precedence summary:

| Concern        | Highest precedence -> lowest precedence                                                               | Notes                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| flat variables | CLI/MCP overrides -> step `with` -> run `inputs` -> request defaults -> env values -> config defaults | extracted values are explicit only via `steps.<stepId>.<field>` |
| headers        | inline request headers -> later listed header blocks -> earlier listed header blocks                  | header names are matched case-insensitively                     |
| auth           | inline request `auth` or `uses.auth`                                                                  | mutually exclusive in v0                                        |
| body           | request-local inline body or request-local body file                                                  | no body blocks in v0                                            |
| params         | request-local params with interpolated values                                                         | no param blocks in v0                                           |

### 10.5 Secret resolution

v0 supports two runtime-only secret sources:

1. direct `$ENV:NAME` references
2. `.httpi/secrets.yaml` aliases referenced as `{{secrets.aliasName}}`

Secret rules:

- missing secrets fail execution with a clear error
- secret-bearing values are redacted from events, session summaries, CLI output, MCP output, and response metadata
- tracked definitions may reference secrets but must not contain secret literals

## 11. Execution Semantics

### 11.1 Project discovery

The engine discovers a project by searching upward from the current working directory for `httpi/config.yaml`.

Discovery rules:

- nearest matching `httpi/config.yaml` wins
- search stops at the Git repository root
- CLI and MCP may accept an explicit project override
- if no project is found, return a clear error instructing the user to run `httpi init`

### 11.2 Validation

All tracked definitions are validated before execution:

- YAML parses successfully
- schema version is supported
- references resolve to existing files
- step IDs are unique across the compiled run
- interpolation placeholders are satisfiable where possible
- tracked files do not contain secret literals in known secret-bearing fields

Validation must return structured diagnostics, including file path and line information when available.

### 11.3 Request execution

Request execution flow:

1. resolve variables and secret references
2. merge reusable blocks with inline request data
3. encode body if present
4. create the resolved request model
5. write the session state for the new attempt
6. execute the HTTP request through `packages/http`
7. evaluate expectations
8. evaluate extractions
9. persist artifacts
10. atomically update session state

`packages/http` should use Node's native `fetch` in v0.

Single-attempt commit sequence:

```text
execution -> runtime : mark step running (attempt N)
execution -> http    : send request
http -> execution    : return response or transport error
execution -> runtime : write request summary and raw response artifacts
execution -> execution : evaluate expectations and extractions
execution -> runtime : write final response metadata
execution -> runtime : atomically commit terminal step + session state
```

If the process exits after the request is sent but before the terminal session commit completes, the step is treated as `interrupted` during recovery.

### 11.4 Parallel semantics

Parallel behavior must be deterministic enough to test and inspect.

Rules:

- child steps under a `parallel` node may start in any order
- each child still emits ordered per-step attempt events
- completed child steps keep their artifacts even if a sibling fails
- if one child fails, remaining running siblings receive cancellation
- the parent `parallel` step completes only after all child states are persisted

### 11.5 Pause and resume semantics

Pause/resume must be explicit and safe.

Rules:

- a `pause` step writes session state and exits before starting the next step
- resume of a paused session starts at `nextStepId`
- resume of a failed session re-attempts the failed step with the next attempt number
- resume continues from the persisted compiled snapshot, not from re-reading current files
- the engine records definition hashes in the session
- environment values are frozen in the compiled snapshot, so env file drift blocks normal resume
- new env or input overrides are not accepted during resume in v0
- secrets are re-resolved only for steps that have not started yet
- incompatible session or artifact schema versions block resume
- if tracked files changed after the session was created, normal resume is blocked until the user starts a new run or explicitly opts into the stored snapshot behavior supported by the interface
- session resumes are single-writer only
- `interrupted` sessions are not resumable through `resume` in v0 because request delivery may be ambiguous; the operator or agent should start a new run

### 11.6 Failure, interruption, and replay safety

v0 should prefer explicitness over hidden retries.

Rules:

- generic automatic retries are out of scope for v0
- each step attempt executes once
- expectation failures produce `failed` steps, not retries
- if the process exits during a running step, the step becomes `interrupted`
- `interrupted` means the engine does not assume the request either did or did not reach the server
- interrupted sessions require a new run in v0

### 11.7 Atomic persistence and locking

Runtime state must be safe under crashes and concurrent callers.

Rules:

- session files are written atomically using temp file plus rename
- artifact files are written before final session commit
- each session has an exclusive lock or lease file
- CLI and MCP cannot both write the same session concurrently
- lock conflicts are surfaced as explicit errors, not silent retries

## 12. Runtime Artifacts

### 12.1 Artifact layout

Every executed session writes artifacts under `.httpi/responses/<sessionId>/`.

```text
.httpi/responses/<sessionId>/
├── manifest.json
├── events.jsonl
└── steps/
    └── <stepId>/
        ├── request.summary.json
        ├── response.meta.json
        └── body.json | body.txt | body.bin
```

### 12.2 Manifest and event log

`manifest.json` should include:

- schema version
- session ID
- run ID
- env ID
- definition hashes
- capture policy
- redaction policy summary
- step list and artifact paths

`events.jsonl` should contain sequence-numbered execution events so humans and agents can reconstruct the run without parsing console output.

### 12.3 Artifact capture rules

Artifact behavior must be explicit:

- request summary is always written for an attempted request
- response metadata is always written when a response exists
- body capture follows the effective capture policy: `full`, `metadata-only`, or `never`
- `sensitive: true` requests or steps default to `metadata-only` unless explicitly overridden
- bodies larger than `maxBodyBytes` are truncated or skipped with size and hash metadata recorded
- JSON bodies may be pretty-printed when that does not lose information
- redaction and sensitivity decisions propagate into session summaries, events, CLI output, MCP output, and response metadata

`response.meta.json` must include at least:

- `sessionId`
- `runId`
- `stepId`
- `requestId`
- `attempt`
- `timestamp`
- `durationMs`
- `status`
- `expectationPassed`
- extraction results and failures
- `contentType`
- `bodyBytes`
- `bodySha256`
- redaction summary
- error class when relevant

## 13. Interface Surfaces

### 13.1 CLI

The CLI is the human-facing adapter over the shared engine.

Initial command surface:

| Command                            | Purpose                                                 |
| ---------------------------------- | ------------------------------------------------------- | ---- | --------- | ----------------------------------------- |
| `httpi init`                       | Scaffold required tracked files and update `.gitignore` |
| `httpi list requests               | runs                                                    | envs | sessions` | Discover project definitions and sessions |
| `httpi validate`                   | Validate definitions and references                     |
| `httpi describe --request <id>`    | Show the resolved definition shape without executing    |
| `httpi describe --run <id>`        | Show compiled run structure and step order              |
| `httpi run --request <id>`         | Execute a single request                                |
| `httpi run --run <id>`             | Execute a run                                           |
| `httpi resume <sessionId>`         | Resume a paused or failed session                       |
| `httpi session show <sessionId>`   | Show session state, drift info, and next step           |
| `httpi artifacts list <sessionId>` | List artifact paths                                     |
| `httpi explain variables ...`      | Show variable provenance and effective values           |

Required CLI UX:

- support explicit project, env, and input overrides
- support machine-readable output mode
- return stable exit codes
- return structured validation errors

Suggested stable exit codes:

- `0`: success
- `1`: execution or expectation failure
- `2`: validation or configuration error
- `3`: lock conflict or unsafe resume/drift
- `4`: internal error

### 13.2 MCP

The MCP server is the AI-facing adapter over the same engine.

Initial tool surface:

| Tool                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `list_definitions`  | Discover requests, runs, envs, and sessions          |
| `validate_project`  | Return validation diagnostics                        |
| `describe_request`  | Explain a request before execution                   |
| `describe_run`      | Explain a run, step graph, and dependencies          |
| `run_definition`    | Execute a request or run                             |
| `resume_session`    | Resume a session                                     |
| `get_session_state` | Read session state, next step, and drift information |
| `list_artifacts`    | Enumerate artifacts for a session or step            |
| `read_artifact`     | Read a captured artifact subject to redaction policy |
| `explain_variables` | Return effective values and provenance               |

### 13.3 CLI/MCP parity contract

The same engine must back both interfaces.

| Capability          | CLI                      | MCP                                | Shared contract            |
| ------------------- | ------------------------ | ---------------------------------- | -------------------------- |
| list definitions    | `httpi list ...`         | `list_definitions`                 | same IDs and metadata      |
| validate project    | `httpi validate`         | `validate_project`                 | same diagnostics schema    |
| describe before run | `httpi describe ...`     | `describe_request`, `describe_run` | same compiled model fields |
| execute             | `httpi run ...`          | `run_definition`                   | same session/result schema |
| resume              | `httpi resume ...`       | `resume_session`                   | same drift and lock rules  |
| inspect session     | `httpi session show ...` | `get_session_state`                | same state machine         |
| inspect artifacts   | `httpi artifacts ...`    | `list_artifacts`, `read_artifact`  | same redaction policy      |

## 14. Security, Reliability, and Observability

### 14.1 Security

Security-sensitive behavior is part of v0, not later hardening.

Rules:

- `.httpi/` must be Git-ignored
- `httpi init` must add `.httpi/` to `.gitignore`
- `httpi validate` and runtime execution should warn or fail if `.httpi/` is not ignored
- tracked files must not contain secret literals in known secret-bearing fields
- `.httpi/secrets.yaml`, session files, and artifacts should be owner-readable only when supported
- redaction must cover request headers, response headers, extraction results, known sensitive JSON paths, and error strings
- MCP artifact reads must obey the same redaction and sensitivity policy as CLI output

### 14.2 Reliability

Rules:

- session state is persisted after each step transition
- locking prevents double resume and concurrent writers
- on-disk artifacts and sessions carry schema versions
- definition hashes detect drift between session start and resume
- artifacts are still written for failed HTTP responses when a response exists

### 14.3 Observability

Execution events must be typed and structured.

Required fields on lifecycle events:

- `schemaVersion`
- `eventType`
- `timestamp`
- `sessionId`
- `runId`
- `stepId` when applicable
- `attempt`
- `durationMs` when applicable
- `outcome`
- `errorClass` when applicable
- `artifactPath` when applicable

Core event types:

- `run.started`
- `step.started`
- `step.completed`
- `step.paused`
- `step.failed`
- `session.interrupted`
- `run.completed`

## 15. Testing Strategy

The idea doc explicitly treats `testing/` as both a code-testing area and an agent-validation area.

Recommended structure:

```text
testing/httpi/
├── fixtures/   # payloads, env files, sample definitions, golden artifacts
├── flows/      # canonical end-to-end request/run flows
└── judge/      # pass/fail checklists for agent-driven validation
```

### 15.1 Test layers

1. **Unit tests** for schemas, identity/reference resolution, variable resolution, redaction, and locking helpers
2. **Integration tests** for HTTP execution, artifact capture, and session persistence against a mock server
3. **End-to-end tests** for pause/resume, parallel groups, drift detection, and CLI/MCP parity
4. **Agent validation docs** describing how a coding agent should inspect artifacts and decide whether a flow passed

### 15.2 Canonical acceptance fixtures

v0 should ship with canonical flows covering:

| Flow                       | Required assertions                                          |
| -------------------------- | ------------------------------------------------------------ |
| hello world single request | project discovery, validation, response capture              |
| login then fetch           | extraction, step-scoped values, auth reuse                   |
| parallel reads             | stable step IDs, joined completion, sibling failure handling |
| pause and resume           | persisted session, next step, resumed completion             |
| sensitive request          | redaction, metadata-only capture                             |
| CLI and MCP parity         | same session/result/artifact semantics                       |

## 16. Contributor Build Order

The first implementation steps should be explicit for a new contributor.

1. **`packages/contracts`**: define schema versioning, event payloads, session/result shapes, and JSON schemas
2. **`packages/definitions`**: implement project discovery, path-derived IDs, YAML loaders, and validators
3. **`packages/http`**: implement single-request execution and body encoding
4. **`packages/runtime`**: implement atomic session persistence, locking, manifest writing, and redaction-aware artifact capture
5. **`packages/execution`**: compile run files, resolve variables, schedule sequential and parallel steps, and implement pause/resume
6. **`apps/cli`**: implement `validate`, `describe`, `run`, `resume`, and session/artifact inspection
7. **`apps/mcp`**: mirror the same execution and inspection surface for agents
8. **`testing/httpi`**: add canonical fixtures, flows, mock-server coverage, and judge docs

## 17. Key Decisions

1. **Run files replace separate sequence files in v0**  
   One orchestration concept is enough for the first implementation.

2. **Path-derived IDs are canonical**  
   Optional `title` exists for readability, but file paths define identity.

3. **`uses` is the shared reference keyword**  
   The architecture avoids `use` versus `uses` drift.

4. **Extracted values are namespaced by step ID**  
   This preserves provenance and prevents silent collisions.

5. **Resume uses the persisted compiled snapshot**  
   Resume should be predictable, with drift detection rather than re-reading changed files silently.

6. **Pause/resume, redaction, and artifact semantics are core scope**  
   They are not postponed to a later hardening phase.

7. **CLI and MCP must expose the same underlying behavior**  
   Human and AI workflows should not diverge in semantics.

## 18. Summary

The v0 architecture for `httpi` should stay sharp and boring in the best way:

- **requests** are the main executable unit
- **runs** define order, parallelism, and pause points
- **sessions** make execution resumable and inspectable
- **`.httpi/`** stores local runtime state and artifacts
- **CLI and MCP** share one typed engine and one runtime model
- **testing/httpi/** holds both executable fixtures and judge-oriented validation assets

That is enough to satisfy the idea doc while giving implementation a clearer contract for identity, safety, agent ergonomics, developer experience, and testability.
