<!-- @format -->

# Runmark brand foundation

**Status**: Internal draft  
**Current implementation name**: `httpi`  
**Target brand**: `Runmark`  
**Companion docs**: [voice and messaging](voice-and-messaging.md), [visual system](visual-system.md), [applications](applications.md), [rebrand transition](rebrand-transition.md)

---

## 1. What Runmark is

Runmark is a repo-native HTTP workflow runner.

It keeps tracked workflow definitions in `runmark/`, local runtime evidence in
`runmark/artifacts/`, and exposes the same execution model through both a CLI
and an MCP server.

This product is not built around sending one request. It is built around
running workflows you can trust:

1. define request and run files beside the code they exercise
2. validate before execution
3. inspect resolved values before risky work
4. execute a real HTTP flow
5. inspect saved outputs after each run
6. pause on purpose, then resume only when it is safe

Runmark gives that loop a home in the repository instead of scattering it
across shell history, desktop workspaces, and hidden local state.

## 2. Core product narrative

Most HTTP tools are strong at direct request sending. The harder part is
keeping real API validation reviewable, inspectable, and resumable while the API
is still changing.

That is the work Runmark is for.

Tracked files describe what should happen. Git-ignored runtime files record what
did happen. The CLI and MCP use the same engine, so a human and a coding agent
can run the same flow, inspect the same evidence, and follow the same safety
rules.

The result should feel calmer than a typical API-tool workflow:

- no hidden workspace as the source of truth
- no ad hoc shell script as the only record
- no guesswork about what the agent actually ran
- no unsafe resume after files or inputs changed

## 3. Category framing

### Primary category

**Repo-native HTTP workflow runner**

This is the clearest category anchor because it says:

- **repo-native** - the source of truth lives with the code
- **HTTP** - the problem space is concrete
- **workflow runner** - the product is more than a single-request client

### Supporting frame

**File-based API validation for developers and agents**

Use this when the audience needs the outcome more than the taxonomy.

### What Runmark is not

- not a GUI-first API workspace
- not a hosted collaboration platform
- not a general CI runner
- not a generic workflow orchestration engine
- not “just another HTTP CLI”

## 4. Who it is for

### Backend and full-stack developers

People actively changing APIs who want validation to live in the same repo as
the code they are shipping.

**Job to be done:** keep API checks close to the code, rerun them reliably, and
inspect failures from saved evidence instead of rebuilding context from memory.

### Developers using coding agents

People using Claude Code, Copilot, Cursor, or custom agent setups who need the
agent to run the same workflow a human would use.

**Job to be done:** give the agent one inspectable execution surface with saved
outputs, explicit checkpoints, and safe continuation.

### Platform, infra, and operator-minded teams

Teams maintaining APIs, gateways, or HTTP-based runbooks where mutating work
should stop for inspection before it continues.

**Job to be done:** turn operational HTTP flows into readable files with local
evidence, redaction, and explicit pause/resume behavior.

## 5. What makes Runmark different

### Tracked intent, local evidence

This is the product’s sharpest split:

- `runmark/` describes **what should happen**
- `runmark/artifacts/` records **what did happen**

That makes workflow intent reviewable in Git and runtime evidence inspectable
without polluting tracked files.

### Request-first authoring, run-first execution

Request files stay small and readable. Run files own sequencing, parallel work,
and pause points. This keeps the first useful workflow small while still making
room for real orchestration.

### Pause and resume are first-class

Runmark is not just about success or failure. It is built for deliberate flow
control:

1. stop at a meaningful checkpoint
2. inspect saved outputs
3. resume only when the next step is still safe

### One engine across CLI and MCP

Humans and coding agents should not use different execution models. Runmark
keeps the same workflow contract across both surfaces.

### Redaction and drift checks are built in

Runmark redacts secret-bearing values in outputs and blocks unsafe resume when
tracked definitions or relevant inputs have changed.

## 6. Differentiation

| Compared with | What they do well | Where Runmark is different |
| --- | --- | --- |
| Postman / Insomnia | GUI exploration, collections, collaboration | Runmark keeps workflow definitions in the repo and runtime evidence local |
| Bruno | file-based request collections | Runmark pushes further into sessions, artifacts, pause/resume, and CLI/MCP parity |
| HTTPie / curl | fast one-off requests | Runmark is built for named, repeatable, multi-step flows |
| StepCI / scenario runners | CI-style API checks and assertions | Runmark focuses on inspectable local runs, saved outputs, and resume control |
| Generic workflow tools | broad orchestration and automation | Runmark stays narrow on repo-local HTTP validation and runbooks |

## 7. Message hierarchy

### Core message

**Run API workflows from files in your repo.**

### Supporting message

Keep request intent tracked, runtime evidence local, and execution consistent
across CLI and MCP.

### Proof points

- requests and runs live in versioned files
- sessions and artifacts are saved locally
- pause/resume is explicit
- secret-bearing values are redacted in outputs
- resume is blocked when tracked definitions drift

## 8. Why the name “Runmark”

The old name, `httpi`, pointed at the protocol. The new name points at the
actual job.

**Runmark** combines two ideas that sit at the center of the product:

- **run** - the unit of execution
- **mark** - the visible result a run leaves behind

That matches the product model well:

1. define a run
2. execute a run
3. inspect the mark it leaves in sessions and artifacts
4. resume from a marked checkpoint when it is still safe

Runmark is more durable than `httpi` because it makes room for workflows,
evidence, continuation, and trust without sounding like another generic HTTP
tool.

## 9. Guardrails

### Avoid overclaiming

Runmark should not claim to be:

- the source of truth for all API quality
- a compliance or audit platform
- a production-safe autonomous agent layer
- a full replacement for GUI workspaces, CI, or orchestration systems

### Stay concrete

Prefer:

- request files
- run files
- saved outputs
- local artifacts
- pause before mutation
- resume only if files and inputs have not changed

Over:

- orchestration surface
- deterministic workflows
- compliance-grade evidence
- autonomous execution platform

### Keep the product narrow on purpose

The foundation should stay centered on:

1. tracked request and run files
2. local artifacts and sessions
3. explicit pause/resume
4. CLI and MCP parity
5. redaction and drift-safe continuation

## 10. Working brand summary

**Runmark is the repo-native way to run API workflows: with tracked
definitions, local evidence, explicit pause/resume, and one workflow engine for
developers and coding agents.**
