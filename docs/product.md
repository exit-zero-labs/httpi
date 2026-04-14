<!-- @format -->

# Runmark - Product Overview

**Status**: Pre-1.0  
**Audience**: Humans first; also useful context for coding agents  
**Companion docs**: [`architecture.md`](architecture.md), [`archive-architecture.md`](archive-architecture.md), [`idea.md`](idea.md)

---

## 1. What `runmark` is

`runmark` is an open-source HTTP client, CLI, and MCP project for running API workflows from files that live in your repository.

Instead of hiding everything inside a GUI collection or a local desktop session, `runmark` treats requests, environments, and multi-step runs as readable project files. That makes them easy to review in Git, easy to evolve with the API they exercise, and easy for both humans and coding agents to understand.

## 2. Why it exists

Most API testing tools are good at sending requests, but they break down when the workflow needs to be:

- modular
- reusable
- easy to diff in Git
- safe for secrets
- inspectable by AI agents
- resumable after a pause or failure

The motivating use case is simple: you are actively changing an API, often with an AI coding agent helping, and you need a clear way to validate real HTTP flows before and after each change. Some requests are independent, some must run in sequence, some should pause for inspection, and every response should be captured somewhere predictable.

`runmark` is designed around that workflow.

## 3. The core promise

`runmark` should feel like:

1. **A file-based HTTP client** that lives comfortably inside a real codebase.
2. **A workflow runner** that can express sequential, parallel, and pause-aware API flows.
3. **A shared execution engine** that works the same way through a CLI and an MCP server.
4. **A trustworthy inspection surface** where request/response artifacts are captured locally, redacted where needed, and easy to compare.

## 4. Who it is for

### Backend and full-stack developers

People iterating on APIs who want request definitions close to the code they are validating.

### AI-assisted coding workflows

Claude Code, GitHub Copilot, and other agents that need a stable, inspectable way to run validation flows and judge outcomes from artifacts instead of hidden session state.

### Technical teams that care about reviewability

Teams who want request logic, env shape, and expected outcomes to live in plain files that can be reviewed, discussed, and versioned like any other source file.

## 5. What makes `runmark` different

### Git-tracked intent, local runtime state

The important definitions live in tracked files. Local runtime state lives in a Git-ignored directory.

That gives `runmark` a clean split:

- `runmark/` describes **what should happen**
- `runmark/artifacts/` stores **what did happen**

### Request-first authoring

The main thing people write is a request file. Reuse exists, but it does not dominate the mental model.

### Runs as the orchestration layer

A run file wires requests together, including sequential steps, parallel groups, and explicit pause points.

### Pause and resume for real inspection

`runmark` is not just about success/failure. It is also about controlled execution. A run can stop at a meaningful checkpoint, persist its state, let a human or agent inspect the artifacts, and continue later.

### Human and AI parity

The CLI and MCP surfaces should expose the same definitions, the same session model, the same artifacts, and the same safety rules.

### Compared with GUI-first API clients

`runmark` is not trying to be a Postman-style desktop workspace inside your repository. It is optimized for a narrower but very practical workflow: versioned request intent, explicit orchestration, local runtime artifacts, and agent-friendly inspection.

| Concern | GUI-first API client | `runmark` |
| ------- | -------------------- | ------- |
| Source of truth | local collection or synced workspace | tracked files in the repo |
| Runtime state | hidden inside the client or cloud workspace | explicit under `runmark/artifacts/` |
| Pause and resume | usually manual and ad hoc | explicit run step and resumable session |
| AI-agent inspection | depends on the client session | same workflow through CLI and MCP |
| Reviewability | export or screenshot after the fact | diff the request and run files directly |

### Where it fits best right now

`runmark` is a strong fit when:

- API validation belongs in the same repository as the code under test
- a human or coding agent needs to inspect artifacts before a mutating step continues
- teams want predictable, reviewable YAML instead of hidden collection state
- CLI automation and MCP-based tooling should share one execution contract

If the primary need is a polished GUI collection editor, hosted collaboration, or importer-heavy workflow migration, a GUI-first tool may be a better fit today.

## 6. The user experience goal

The first useful experience should stay small and should not require extra infrastructure.

A developer should be able to initialize a project, use the bundled demo API or point one env file at their own service, then validate and execute that flow within a few minutes.

```text
runmark/
├── config.yaml
├── env/
│   └── dev.env.yaml
├── requests/
│   └── ping.request.yaml
└── runs/
    └── smoke.run.yaml
```

The “power-user” experience comes later from composition, not from up-front ceremony.

In practice, the first useful workflow should include:

1. `init`
2. `demo start` (or point `baseUrl` at a real service)
3. `validate`
4. `describe`
5. `explain variables`
6. `run`
7. `session` and `artifacts` inspection
8. `resume` when a run intentionally pauses

## 7. Core concepts

| Concept         | What it means                                                         |
| --------------- | --------------------------------------------------------------------- |
| **Project**     | A repository that contains tracked `runmark/` definitions               |
| **Environment** | Non-secret values for a named context like `dev` or `staging`         |
| **Request**     | One HTTP interaction                                                  |
| **Run**         | A multi-step workflow composed of request, parallel, and pause steps  |
| **Session**     | The persisted runtime record of one run execution                     |
| **Artifacts**   | Captured request records, responses, and bodies written under `runmark/artifacts/` |

## 8. Golden-path workflow

The intended happy path is:

1. initialize the project
2. define a small environment
3. author one or more request files
4. define a run that references those requests
5. validate before execution
6. execute through CLI or MCP
7. inspect local artifacts
8. resume if the workflow intentionally paused

The important part is not just “send a request.” It is “run an inspectable workflow from source-controlled definitions.”

## 9. Example workflow shape

The key workflow `runmark` is built to support looks like this:

1. authenticate
2. extract a token or ID from the login response
3. fan out into parallel reads
4. pause so a human or agent can inspect artifacts
5. resume into a mutating request only after inspection

That is the shape of real API validation work, especially when agents are involved.

## 10. Product principles

1. **Readable by default** - a new contributor should understand the file layout quickly.
2. **Composable without being ceremonial** - reuse exists, but simple flows stay simple.
3. **Inspectable over magical** - session state, variable provenance, and artifacts should be explainable.
4. **Safe by default** - secrets stay local, runtime artifacts are redacted, and resume behavior is explicit.
5. **Built for automation** - agents should not need hidden context to do reliable validation.

## 11. v0 scope

The initial version is intentionally focused.

### In scope

- YAML-based tracked definitions
- named environments
- request files
- run files
- reusable header/auth blocks
- persisted sessions
- local artifact capture
- shared engine for CLI and MCP
- test and judge assets under `testing/`

### Out of scope

- GUI or desktop interface
- hosted workspace or sync layer
- external secret manager integrations
- generalized plugin system
- importers from Postman, Bruno, or OpenAPI
- broad retry automation

### Pre-1.0 stability note

`runmark` is still pre-1.0, but the project is intended to keep the core tracked file model, CLI/MCP workflow, example-first reference set, and pause/resume inspection flow recognizable and stable while adoption and hardening work continues.

User-visible changes inside that line are tracked in [`../CHANGELOG.md`](../CHANGELOG.md).

## 12. Open-source posture

`runmark` is being set up as an open-source Exit Zero Labs project.

That means the repo should optimize for:

- clear public docs
- predictable contributor onboarding
- visible architecture decisions
- consistent AI-assistant instructions
- standard community files
- a minimal but real workspace scaffold

The near-term implementation priorities for that open-source posture live in [`docs/roadmap.md`](roadmap.md).

## 13. What success looks like

`runmark` is successful when:

1. a developer can define and run a small API flow quickly
2. an AI agent can discover the same files and reason about the same outcomes
3. pause/resume works without hidden ambiguity
4. artifacts are easy to inspect and compare
5. the repository is structured clearly enough for contributors to implement the system in phases
