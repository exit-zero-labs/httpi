<!-- @format -->

# Runmark voice and messaging

**Status**: Internal draft  
**Current implementation name**: `httpi`  
**Companion docs**: [brand foundation](brand-foundation.md), [visual system](visual-system.md), [applications](applications.md)

---

## 1. Voice

Runmark should sound:

- direct
- crafted
- grounded
- human
- calm under pressure

The tone should feel like a trusted operator explaining a tool they actually
use, not a startup trying to inflate a category.

## 2. One-line descriptor

**Runmark is a repo-native, file-based HTTP workflow runner with CLI and MCP parity.**

Useful alternates:

- **Versioned HTTP workflows for your repo, your CLI, and your coding agents.**
- **File-based API workflows with local artifacts, safe resume, and shared execution across CLI and MCP.**

## 3. Core messaging blocks

### Positioning statement

Runmark is the repo-native HTTP workflow runner for teams that want API
validation to live in code, not in a separate workspace. It keeps request and
run definitions in plain files, stores runtime sessions and saved outputs
locally, and gives humans and coding agents the same execution model through
the CLI and MCP.

### Short product statement

Runmark lets you define and run real API workflows from files in your
repository.

### Best short-form line

**Run API workflows from repo files — with local artifacts, safe pause/resume, and CLI/MCP parity.**

## 4. Homepage hero options

### Option 1

**HTTP workflows that live in your repo**  
Define requests and multi-step runs in plain files, run them from the CLI or
MCP, and inspect local sessions and artifacts with redaction by default.

### Option 2

**The file-based runner for real API workflows**  
Runmark handles the flows that break ad hoc API clients: multi-step runs,
checkpoints, saved outputs, pause/resume, and drift-safe continuation.

### Option 3

**One HTTP workflow model for developers and coding agents**  
Author once in your repo. Execute through CLI or MCP. Review what happened from
persisted, local, redacted outputs.

## 5. Supporting value props

1. **Repo-native by design**  
   Requests, environments, and runs live in versioned files next to the code
   they validate.
2. **Built for multi-step workflows**  
   Go beyond single requests with sequential steps, parallel branches, and
   explicit pause checkpoints.
3. **CLI and MCP parity**  
   Humans and coding agents use the same engine, the same artifacts, and the
   same safety rules.
4. **Inspectable local runtime**  
   Sessions and saved outputs are persisted locally so you can review what
   happened without hidden client state.
5. **Safe by default**  
   Redaction is on by default, secrets stay out of tracked files, and resume is
   blocked when definitions or inputs drift.

## 6. Audience-specific cuts

### Backend developers

**Keep API validation in the same repo as the code you ship.**  
Runmark gives you file-based requests and runs you can diff, review, and evolve
alongside your API.

### AI-assisted developers

**Give your coding agent a stable way to run real HTTP workflows.**  
Runmark exposes the same model through CLI and MCP, with explicit definitions,
saved outputs, redaction, and drift-safe resume.

### Platform and ops teams

**Turn runbooks into inspectable HTTP workflows.**  
Use Runmark for operator flows that need checkpoints before mutation: gather
diagnostics, pause for review, then resume safely.

## 7. README opening

```md
# Runmark

Runmark is a repo-native, file-based HTTP workflow runner.

It keeps tracked request intent in `runmark/`, runtime state in `runmark/artifacts/`, and exposes the same execution model through both a CLI and an MCP server.

Use it when API validation should live next to the code it exercises: with explicit runs, inspectable artifacts, redacted secrets, pause/resume control, and drift-safe resume for both humans and agents.
```

## 8. What-it-solves copy

```md
## What it solves

Most HTTP tooling is good at sending requests. The harder part is keeping real workflow validation reviewable, repeatable, and safe.

Runmark helps when you need to:

- keep request definitions in the repo, not trapped in a local workspace
- model real API flows, including sequential steps, parallel work, and pause points
- inspect what happened after a run through saved sessions and outputs
- give humans and agents the same execution model through CLI and MCP
- keep secrets out of tracked files and redacted in output
- block unsafe resume when definitions or environment inputs have changed
```

## 9. Preferred phrases

| Prefer | Over |
| --- | --- |
| requests and runs | collections |
| saved outputs | opaque artifacts on first mention |
| local artifacts | runtime state as the first phrase |
| pause for inspection, then resume | pause-aware orchestration |
| same workflow through CLI and agent tools | MCP parity as the lead phrase |
| resume only if files and inputs have not changed | drift-safe continuation as the first phrase |
| developers and coding agents | humans and AI agents everywhere |

## 10. Terms to avoid

- Postman killer
- AI-native API platform
- autonomous workflow layer
- deterministic API workflows
- compliance-grade audit trail
- cloud collaboration suite
- low-code automation
- full orchestration platform

## 11. Rename explanation copy

### Short version

```md
## Why the name changed

`httpi` got us started, but the product outgrew the name.

The work is not just HTTP requests. It is defining runs, pausing at the right moment, inspecting saved outputs, redacting sensitive values, and resuming safely across both CLI and MCP.

Runmark better matches that job. It names the unit that matters: a run you can mark, inspect, and return to with confidence.
```

### Release-note version

```md
### httpi is becoming Runmark

We are moving from `httpi` to **Runmark**.

The old name pointed at the protocol. The new name points at the workflow.

This product is built for tracked runs, saved outputs, explicit pause/resume, redaction, and drift-safe execution across both CLI and MCP. Runmark says more clearly what the tool is for and how it is used.
```

## 12. Tagline options

- Run API workflows from your repo.
- File-based HTTP workflows, built for real repos.
- One workflow engine for CLI and MCP.
- Inspectable API runs for developers and coding agents.
- Versioned request intent. Inspectable runtime evidence.
- Pause, inspect, resume — without losing the thread.
- Keep API validation close to the code.
