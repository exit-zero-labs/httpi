# httpi

`httpi` is an open-source HTTP client, CLI, and MCP project for running modular, Git-tracked HTTP workflows that work well for both humans and AI agents.

## Status

Architecture and repository scaffolding are in place. Runtime implementation follows next.

## Why it exists

`httpi` is designed for real API iteration work:

- define requests and runs in readable project files
- keep intent in Git and runtime state out of Git
- pause and resume workflows intentionally
- capture artifacts for inspection and comparison
- let humans and MCP-compatible agents reason about the same execution model

## Documentation

- [`docs/product.md`](docs/product.md) - high-level product overview
- [`docs/architecture.md`](docs/architecture.md) - current technical architecture
- [`docs/archive-architecture.md`](docs/archive-architecture.md) - preserved first draft
- [`docs/idea.md`](docs/idea.md) - original idea and motivation
- [`docs/roadmap.md`](docs/roadmap.md) - reserved for the phased implementation plan

## Repository layout

```text
apps/        CLI and MCP entrypoints
packages/    shared engine packages
docs/        product and architecture documents
testing/     fixtures, flows, and judge-oriented validation assets
```

## Local commands

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm build
```
