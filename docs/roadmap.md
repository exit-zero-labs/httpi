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

## Deferred example candidates

The public `examples/` catalog should keep growing, but some example families are better treated as roadmap work than as current reference projects. These should land only after their docs, tests, and operator guidance are strong enough to make them trustworthy copyable examples.

| Candidate | Why deferred |
| --- | --- |
| `oauth2-client-credentials` service-auth example | wait until token lifecycle guidance and reference coverage are stronger |
| `hmac` signed-request example | wait until signing ergonomics and docs are polished enough to teach safely |
| `pollUntil` job-status example | wait until polling guidance and fixture-backed coverage are broader |
| `switch` branching example | wait until branching workflows have better real-world documentation and tests |
| snapshot-based contract example | wait until snapshot authoring and acceptance workflows are documented more concretely |
| streaming or webhook-style example | wait until the inspection and runtime story is mature enough for a stable public reference |

## Guardrails

Even as the roadmap expands, the core architectural constraints stay the same:

- keep `apps/cli` thin — both the CLI and the `httpi mcp` stdio server are pure adapters over the shared engine
- keep tracked request intent in `httpi/` and runtime state in `httpi/artifacts/`
- keep definitions pure data with no hidden scripting model
- prefer explicit, inspectable behavior over magical convenience
