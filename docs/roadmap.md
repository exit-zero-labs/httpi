<!-- @format -->

# httpi - Roadmap

**Status**: Active v0 follow-up

`httpi` already has a working v0 baseline. This roadmap captures the next layers of polish and adoption work, not a promise of dates.

## Current focus

The current priority is to make the existing v0 easier to adopt and easier to trust:

1. sharpen the public story and first-run guidance
2. make agent and contributor workflows easier to inspect
3. broaden tests and judge assets around the commands that already exist
4. continue tightening runtime safety and clarity without adding hidden magic

## Near-term phases

### 1. Documentation and adoption

- strengthen README, product positioning, and contribution guidance
- make the roadmap itself visible and useful
- improve troubleshooting, examples, and fixture-backed validation guidance
- add issue intake paths that keep bug reports and feature ideas focused

### 2. Authoring and inspection clarity

- document the current command surface more concretely
- make `describe`, `explain variables`, session inspection, and artifact inspection easier to learn
- expand judge-oriented acceptance criteria for human and agent workflows
- keep architecture docs tightly aligned with the real implementation

### 3. Runtime hardening

- continue tightening redaction and local runtime file safety
- clarify interrupt, pause, resume, and parallel-step semantics
- expand reliability guidance around what v0 does today and what remains intentionally manual
- evaluate future retry or cancellation work without compromising explainability

### 4. Distribution and editor integrations

- improve the packaging and publishing story for the CLI and MCP adapters
- ship and refine editor and schema support for tracked YAML files
- add more automation examples for CI and agent-driven validation flows

## Guardrails

Even as the roadmap expands, the core architectural constraints stay the same:

- keep `apps/cli` thin — both the CLI and the `httpi mcp` stdio server are pure adapters over the shared engine
- keep tracked request intent in `httpi/` and runtime state in `.httpi/`
- keep definitions pure data with no hidden scripting model
- prefer explicit, inspectable behavior over magical convenience
