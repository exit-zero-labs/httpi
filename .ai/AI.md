<!-- @format -->

# httpi - Shared AI Instructions

<!-- E0L company-wide context (agent personas, architecture decisions, git workflow).
     Available inside dev container via the .e0l symlink -> /workspace-config.
     Silently skipped if not present. -->

@./.e0l/.ai/AI.md

`httpi` is an open-source HTTP client, CLI, and MCP project for defining, executing, pausing, resuming, and inspecting HTTP workflows from a Git-tracked repository.

## Canonical documents

- `docs/product.md` - user-facing product overview
- `docs/architecture.md` - current technical architecture
- `docs/archive-architecture.md` - archived first-pass architecture draft
- `docs/idea.md` - original motivation and scope notes
- `README.md` - public entrypoint for the repository

## Stack and tooling

- Node.js 20+
- TypeScript 5.x in strict mode
- pnpm 10 + Turborepo
- Biome for linting and formatting
- Native `fetch` for HTTP transport in Node
- YAML definitions plus JSON/JSONL runtime artifacts

## Commands

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm build
```

## Architecture rules

1. **Tracked intent vs untracked runtime**
   - `httpi/` is the tracked source of truth
   - `.httpi/` is local runtime state and must stay Git-ignored

2. **Thin interface adapters**
   - `apps/cli` and `apps/mcp` stay thin
   - execution logic belongs in shared packages

3. **Request-first authoring**
   - request files are the primary unit people and agents read and edit
   - run files own sequencing, parallelism, and pauses

4. **No hidden scripting model**
   - tracked definitions remain pure data
   - do not add embedded scripts or magical execution hooks

5. **Path-derived identity**
   - canonical IDs come from file paths, not mutable `name` fields

6. **Safety first**
   - never commit secret literals to tracked files
   - keep redaction, artifact capture, and resume safety aligned across CLI and MCP

## Repository conventions

- named exports only
- no `any`
- files use kebab-case
- functions and variables use camelCase
- types and interfaces use PascalCase
- prefer explicit types at public boundaries
- keep `packages/shared` as a true leaf utility package

## Repository map

```text
apps/        CLI and MCP entrypoints
packages/    contracts, definitions, execution, runtime, http, shared
docs/        product and architecture docs
testing/     fixtures, flows, and judge-oriented validation assets
```
