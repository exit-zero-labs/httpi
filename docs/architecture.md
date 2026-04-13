<!-- @format -->

# httpi - Technical Architecture

**Status**: Current v0  
**Audience**: Contributors implementing the system  
**Companion docs**: [`product.md`](product.md), [`archive-architecture.md`](archive-architecture.md), [`roadmap.md`](roadmap.md)

---

## 1. Purpose

`httpi` is a file-based HTTP client, CLI, and MCP project for defining and executing HTTP request workflows from a Git-tracked repository.

The architecture is built around four constraints:

1. tracked files describe request intent
2. untracked files capture runtime state
3. CLI and MCP must share one execution engine
4. pause, resume, inspection, and redaction are first-class concerns

## 2. System goals

### Primary goals

- allow humans and AI agents to work from the same request definitions
- keep the authoring model small enough for a “first 5 minutes” experience
- support modular reuse without forcing it for simple projects
- persist session state and artifacts deterministically
- make variable resolution and runtime provenance explainable

### Non-goals for the first implementation

- GUI or desktop app
- hosted/cloud sync model
- generalized plugin runtime
- embedded scripting inside tracked definitions
- automatic retry orchestration
- importers from external API client formats

## 3. Design principles

1. **Request-first authoring** - request files are the main unit people read and edit.
2. **Runs own orchestration** - sequencing, parallelism, and pause points live in run files.
3. **Tracked intent, untracked runtime** - `httpi/` is source of truth; `.httpi/` is local execution state.
4. **Strict typing at every boundary** - file formats, compiled models, events, sessions, and interface payloads use runtime schemas and TypeScript types.
5. **One engine, many adapters** - CLI and MCP wrap the same core packages.
6. **Explainable execution** - step state, variable provenance, extracted values, and artifacts must be inspectable.
7. **Safe defaults** - no implicit secret storage in tracked files and no ambiguous resume semantics.

## 4. Architecture overview

```text
┌──────────────────────────────────────────────────────────────┐
│ Interfaces                                                   │
│  apps/cli  (`httpi ...` + `httpi mcp` stdio subcommand)      │
└──────────────────────────────┬───────────────────────────────┘
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

### 4.1 End-to-end lifecycle

An `httpi` execution flows through the packages in a fixed order:

1. **interface adapter** (`apps/cli`) parses CLI or MCP input, normalizes options, and selects one shared engine call
2. **definition loading** (`packages/definitions`) discovers the project, loads tracked YAML, validates references, and compiles an immutable snapshot
3. **orchestration** (`packages/execution`) resolves variables and secrets, manages retries and pauses, and advances the session state machine
4. **transport** (`packages/http`) performs the actual HTTP exchange, including buffered, streaming, and binary modes
5. **persistence** (`packages/runtime`) writes sessions, artifacts, events, locks, and cancel markers under `.httpi/`
6. **presentation** (`apps/cli` or MCP) returns redacted results with stable exit codes or tool payloads

The key design constraint is that compilation, execution, and persistence each have a single owner. Interface layers stay thin so CLI and MCP behavior cannot drift.

### 4.2 Hot-path ownership

| Lifecycle stage | Owning package | Why it lives there |
| ---------------- | -------------- | ------------------ |
| Project discovery and typed YAML loading | `packages/definitions` | Path-derived identity, schema validation, and cross-file reference checks need one source of truth |
| Snapshot compilation and request materialization | `packages/execution` | Execution owns precedence rules, step graphs, retries, and provenance |
| HTTP transport and response parsing | `packages/http` | Transport concerns stay isolated from orchestration and storage |
| Sessions, locks, artifacts, and cancel markers | `packages/runtime` | All `.httpi/` on-disk formats and ownership checks stay in one place |
| CLI and MCP rendering | `apps/cli` | Human/operator formatting and MCP schemas should not leak into engine packages |

## 5. Monorepo layout

`httpi` uses a pnpm + Turborepo workspace with a deliberately small package graph.

| Path                   | Responsibility                                                          |
| ---------------------- | ----------------------------------------------------------------------- |
| `apps/cli`             | Single published bin — `httpi ...` for humans, `httpi mcp` stdio MCP server for agents |
| `packages/contracts`   | Cross-boundary schemas, DTOs, events, result payloads, and YAML schemas |
| `packages/definitions` | Project discovery, YAML loading, validation, path-derived identity      |
| `packages/http`        | Request execution, body encoding, transport concerns                    |
| `packages/runtime`     | Session persistence, locking, artifact writing, redaction-aware storage |
| `packages/execution`   | Run compilation, orchestration, variable resolution, pause/resume       |
| `packages/shared`      | Small leaf utilities with no domain ownership                           |

### Package rules

- `apps/*` may depend on packages but not on each other
- `packages/contracts` must not own file IO, HTTP transport, or CLI/MCP formatting
- `packages/execution` is the orchestration layer and may depend on `definitions`, `http`, `runtime`, `contracts`, and `shared`
- `packages/runtime` owns on-disk formats and lock behavior for `.httpi/`
- `packages/shared` stays small and generic; domain logic does not accumulate there

## 6. Project file model

### 6.1 Tracked and untracked directories

```text
repo/
├── httpi/
│   ├── config.yaml
│   ├── env/
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
├── examples/
│   └── */
│       └── httpi/
└── testing/
    └── httpi/
        ├── flows/
        └── judge/
```

### 6.2 File types

| Path                               | Purpose                                            |
| ---------------------------------- | -------------------------------------------------- |
| `httpi/config.yaml`                | Project defaults, capture policy, redaction policy |
| `httpi/env/*.env.yaml`             | Named non-secret environment values                |
| `httpi/blocks/headers/**/*.yaml`   | Reusable header blocks                             |
| `httpi/blocks/auth/**/*.yaml`      | Reusable auth blocks                               |
| `httpi/bodies/**`                  | Reusable request payload files                     |
| `httpi/requests/**/*.request.yaml` | Atomic request definitions                         |
| `httpi/runs/**/*.run.yaml`         | Multi-step execution plans                         |
| `.httpi/secrets.yaml`              | Local secret aliases, normally Git-ignored         |
| `.httpi/sessions/*.json`           | Persisted session snapshots                        |
| `.httpi/responses/<sessionId>/...` | Captured runtime artifacts                         |

### 6.3 Identity and references

Canonical identity is path-derived.

- request ID = path under `httpi/requests/` without `.request.yaml`
- run ID = path under `httpi/runs/` without `.run.yaml`
- env ID = path under `httpi/env/` without `.env.yaml`
- header block ID = path under `httpi/blocks/headers/` without `.yaml`
- auth block ID = path under `httpi/blocks/auth/` without `.yaml`

Files may include an optional `title` for readability, but paths define identity.

Reference rules:

- request definitions use `uses` for reusable blocks
- run steps use `uses` for referenced requests
- step IDs must be unique across the compiled run
- extracted values are referenced explicitly as `{{steps.<stepId>.<field>}}`

### 6.4 Editor and schema support

- tracked YAML authoring schemas live under `packages/contracts/schemas/`
- `.vscode/settings.json` maps repository and fixture `httpi/**/*.yaml` files to those schemas for contributors
- `httpi init` writes `yaml-language-server` `$schema` comments into the starter config, env, request, and run files so generated projects can pick up validation immediately

## 7. Definition model

### 7.1 Project config

`httpi/config.yaml` carries defaults and safety policy, not workflow logic.

```yaml
schemaVersion: 1
project: my-api
defaultEnv: dev

defaults:
  timeoutMs: 10000

capture:
  requestSummary: true
  responseMetadata: true
  responseBody: full
  maxBodyBytes: 1048576
  redactHeaders:
    - authorization
    - cookie
    - set-cookie
```

### 7.2 Environment files

Environment files contain non-secret values that vary by environment.

```yaml
schemaVersion: 1
title: Local development
values:
  baseUrl: http://localhost:3000
  apiVersion: v1
```

### 7.3 Request definitions

Request files define exactly one HTTP interaction.

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

expect:
  status: 200

extract:
  sessionValue:
    from: $.token
    required: true
    secret: true
  userName:
    from: $.profile.name
    required: true
```

Request rules:

- one request equals one outbound HTTP exchange
- request definitions are pure data; embedded scripts are out of scope
- body files resolve relative to `httpi/bodies/`
- inline request headers override block-derived headers
- auth is either inline or block-based in v0, not both
- extracted values can set `secret: true` to preserve redaction for generic aliases in session and artifact output
- failed expectations still write artifacts when a response exists

### 7.4 Run definitions

Run files are the only orchestration artifact in v0.

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
```

Step kinds in v0:

- `request`
- `parallel`
- `pause`

Run rules:

- `with` values are step-local overrides merged into the flat request variable namespace
- parallel child steps join before the parent completes
- pause steps persist session state and exit cleanly
- pause inside a parallel group is invalid in v0
- nested runs are out of scope

## 8. Runtime model

### 8.1 Compiled run snapshot

Tracked YAML is for authoring. Execution happens against a compiled snapshot created at run start.

The snapshot contains:

- schema version
- run ID and env ID
- resolved definition references
- normalized step graph
- definition hashes for referenced tracked files
- effective capture and redaction policy

Frozen at run start:

- tracked definitions and resolved references
- environment values
- run inputs
- request defaults
- capture/redaction policy

Late-bound at step attempt time:

- direct `$ENV:NAME` reads
- `.httpi/secrets.yaml` alias resolution

### 8.2 Sessions

Sessions are first-class runtime objects stored at `.httpi/sessions/<sessionId>.json`.

Each session records:

- `sessionId`
- `runId`
- `envId`
- `state`
- `nextStepId`
- definition hashes
- effective input values
- extracted values and provenance
- step status and attempts
- artifact paths
- timestamps
- pause or failure reason

### 8.3 Session state machine

Session states:

- `created`
- `running`
- `paused`
- `failed`
- `completed`
- `interrupted`

Step states:

- `pending`
- `running`
- `completed`
- `failed`
- `paused`
- `interrupted`

Key rules:

- `paused -> running` requires an explicit resume
- `failed -> running` requires an explicit resume
- `interrupted` means delivery may be ambiguous and the engine must not guess
- resume uses the persisted compiled snapshot, not freshly re-read tracked files
- recovery is intentionally operator-driven: the engine persists evidence for inspection and explicit retry, but it does not auto-replay ambiguous delivery

### 8.4 Variable resolution

Interpolation syntax is `{{name}}` or `{{steps.<stepId>.<field>}}`.

Flat variable precedence, highest to lowest:

1. CLI or MCP invocation overrides
2. step-level `with` values
3. run-level `inputs`
4. request-local defaults
5. selected environment values
6. project config defaults

Extracted values are intentionally not merged into the flat precedence chain. They are only referenced explicitly through `steps.<stepId>.<field>` so provenance stays clear.

Request extractions use a deliberately small JSONPath subset in v0:

- `$`
- `$.field`
- `$.field.nested`
- `$.items[0]`

Wildcards, filters, recursive descent, and other multi-match forms are intentionally out of scope for the current implementation.

### 8.5 Secret resolution

v0 supports two runtime-only secret sources:

1. direct `$ENV:NAME` references
2. `.httpi/secrets.yaml` aliases referenced as `{{secrets.aliasName}}`

Secret rules:

- missing secrets fail execution clearly
- secret-bearing values are redacted from events, summaries, CLI output, MCP output, and metadata
- tracked files may reference secrets but must not contain secret literals

## 9. Execution semantics

### 9.1 Project discovery

The engine searches upward from the current working directory for `httpi/config.yaml`.

Discovery rules:

- nearest matching config wins
- search stops at the Git repository root
- CLI and MCP may accept an explicit project override
- if no project is found, the interface should instruct the operator to run `httpi init`

### 9.2 Validation

All tracked definitions are validated before execution:

- YAML parses
- schema version is supported
- references resolve
- step IDs are unique across the compiled run
- placeholders are satisfiable where possible
- tracked definitions do not contain secret literals in known secret-bearing fields

Validation results must be structured and include file and line information when available.

### 9.3 Request execution flow

```text
1. resolve variables and secret references
2. merge reusable blocks with inline request data
3. encode the body if present
4. materialize a resolved request model
5. mark the step running for attempt N
6. execute HTTP through packages/http
7. evaluate expectations
8. evaluate extractions
9. persist artifacts
10. atomically commit terminal step and session state
```

In v0, `packages/http` should use Node's native `fetch`.

### 9.4 Parallel behavior

Parallel execution must remain deterministic enough to inspect and test.

Rules:

- children may start in any order
- each child still emits ordered per-step attempt events
- completed child artifacts survive if a sibling fails
- children already in flight are allowed to finish in v0 so inspection stays deterministic
- the parent parallel node fails if any child fails
- the parent parallel node completes only after child states are persisted

### 9.5 Pause and resume

Pause/resume is explicit and safety-oriented.

Rules:

- a pause step writes session state and exits before the next step
- resuming a paused session starts at `nextStepId`
- resuming a failed session re-attempts the failed step
- failed-session recovery is explicit by design; v0 does not auto-retry behind the operator's back
- env values are frozen in the compiled snapshot, so env drift blocks normal resume
- new env or input overrides are not accepted during resume in v0
- secrets are re-resolved only for steps that have not started yet
- incompatible session or artifact schema versions block resume
- file drift blocks normal resume unless the interface deliberately supports stored-snapshot execution
- interrupted sessions are not resumable in v0 because delivery may be ambiguous and the operator should start a new run

Resume follows a deliberate gate sequence:

1. read the persisted session from `.httpi/sessions/`
2. require a resumable state (`paused` or `failed`)
3. compare stored definition hashes against the current tracked files
4. reacquire the session lock so only one caller can continue execution
5. continue from `nextStepId` or re-attempt the failed step using the stored compiled snapshot

That sequence is intentionally stricter than a typical retry loop because `httpi` optimizes for inspectability and delivery safety over convenience.

### 9.6 Persistence and locking

Runtime state must tolerate crashes and concurrent callers.

Rules:

- session files are written atomically with temp-file-plus-rename semantics
- artifact files are written before final session commit
- each session has an exclusive lock or lease file
- CLI and MCP cannot write the same session concurrently
- lock conflicts surface as explicit errors, not silent retries

## 10. Runtime artifacts

Each session writes artifacts under `.httpi/responses/<sessionId>/`.

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

Artifact rules:

- request summaries and response metadata are captured by policy
- bodies may be captured in full, as metadata only, or not at all
- artifacts for failed responses are still written when a response exists
- redaction applies consistently to CLI, MCP, session summaries, and artifact reads

Required lifecycle event fields:

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

## 11. Interface surfaces

### 11.1 CLI

Initial CLI surface:

| Command                            | Purpose                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `httpi init`                       | Scaffold required tracked files and update `.gitignore` |
| `httpi list [requests|runs|envs|sessions]` | Discover project definitions and sessions      |
| `httpi validate`                   | Validate definitions and references                     |
| `httpi describe --request <id>`    | Show resolved request shape without executing           |
| `httpi describe --run <id>`        | Show compiled run structure and step order              |
| `httpi run --request <id>`         | Execute a single request                                |
| `httpi run --run <id>`             | Execute a run                                           |
| `httpi resume <sessionId>`         | Resume a paused or failed session                       |
| `httpi session show <sessionId>`   | Show state, drift info, and next step                   |
| `httpi artifacts list <sessionId>` | List artifact paths                                     |
| `httpi artifacts read <sessionId> <relativePath>` | Read one captured artifact              |
| `httpi explain variables ...`      | Show effective values and provenance                    |

Stable exit code targets:

- `0` success
- `1` execution or expectation failure
- `2` validation or configuration error
- `3` lock conflict or unsafe resume/drift
- `4` internal error

### 11.2 MCP

Initial MCP tool surface:

| Tool                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `list_definitions`  | Discover requests, runs, envs, and sessions          |
| `validate_project`  | Return validation diagnostics                        |
| `describe_request`  | Explain a request before execution                   |
| `describe_run`      | Explain a run, step graph, and dependencies          |
| `run_definition`    | Execute a request or run                             |
| `resume_session`    | Resume a session                                     |
| `get_session_state` | Read session state and drift info                    |
| `list_artifacts`    | Enumerate artifacts for a session or step            |
| `read_artifact`     | Read a captured artifact subject to redaction policy |
| `explain_variables` | Return effective values and provenance               |

### 11.3 Parity contract

The same engine must back both interfaces.

- same definition IDs and metadata
- same diagnostics schema
- same session state machine
- same result payloads
- same artifact semantics
- same redaction policy
- same lock and resume rules

## 12. Security, reliability, and observability

### 12.1 Security

- `.httpi/` must be Git-ignored in normal projects; checked-in examples may include placeholder runtime skeletons
- `httpi init` must add `.httpi/` to `.gitignore`
- tracked files must not contain secret literals in known secret-bearing fields
- runtime-owned session and artifact files should be owner-readable only when supported
- public inspection surfaces should redact request headers, response headers, secret-looking extracted values, and secret-bearing strings
- MCP artifact reads obey the same redaction policy as CLI output

### 12.2 Reliability

- session state is persisted after each step transition
- lock behavior prevents double resume and concurrent writers
- on-disk sessions and artifacts carry schema versions
- definition hashes detect drift between run start and resume
- failed responses still retain inspectable metadata and artifacts when available
- v0 intentionally uses local file locks and explicit operator retries instead of automatic retry orchestration

### 12.3 Observability

- execution events are structured and typed
- session, step, and artifact state is inspectable without hidden memory
- variable resolution should be explainable via provenance output

## 13. Testing strategy

`testing/` is both a code-testing area and an agent-validation area.

Recommended structure:

```text
examples/       public example projects exercised by automated tests
testing/httpi/
├── flows/      # canonical end-to-end request/run flow notes
├── judge/      # pass/fail checklists for agent-driven validation
└── *.test.mjs  # unit, example, E2E, and publish coverage
```

Test layers:

1. unit tests for schemas, identity resolution, interpolation, redaction, and locking helpers
2. integration tests for request execution, artifact capture, and session persistence against a mock server
3. end-to-end tests for pause/resume, parallel groups, drift detection, and CLI/MCP parity
4. agent validation docs that describe how a coding agent should inspect artifacts and decide pass/fail

Canonical acceptance flows should cover:

- single request hello-world
- login then fetch
- parallel reads
- describe and explain-before-run inspection
- pause then resume
- sensitive request with redaction
- CLI and MCP parity

## 14. Implementation order

The architecture is intentionally staged so contributors can build it incrementally:

1. `packages/contracts`
2. `packages/definitions`
3. `packages/http`
4. `packages/runtime`
5. `packages/execution`
6. `apps/cli` (ships both the `httpi` CLI and the `httpi mcp` subcommand)
7. `testing/httpi`

The detailed phase-by-phase plan lives in [`roadmap.md`](roadmap.md) and should stay aligned with the current implementation rather than drift into a separate design universe.
