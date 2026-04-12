<!-- @format -->

# Get started developing httpi

This guide is for contributors and maintainers working inside the `httpi` monorepo. If you want to use the tool, start with [`README.md`](../README.md).

## Prerequisites

- Node.js 20 or newer
- `pnpm` 10.x

## Install and verify

```bash
pnpm install
pnpm check
pnpm test
```

`pnpm check` runs linting, typechecking, and builds. `pnpm test` rebuilds and executes the automated suites, including the public example coverage under `examples/`.

## Daily development loop

For most non-trivial changes:

1. make the code or docs change
2. run `pnpm check`
3. run `pnpm test`
4. exercise `examples/pause-resume` when the change affects CLI, MCP, runtime behavior, or user-facing documentation

A quick manual loop against the canonical example looks like:

```bash
pnpm build
node apps/cli/dist/index.js validate --project-root examples/pause-resume
node apps/cli/dist/index.js describe --run smoke --project-root examples/pause-resume
node apps/cli/dist/index.js explain variables --run smoke --step login --project-root examples/pause-resume
```

## Useful commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | build all workspace packages |
| `pnpm check` | run lint, typecheck, and build together |
| `pnpm test` | run build plus unit, example, E2E, and publish tests |
| `pnpm exec changeset status` | inspect pending release state |
| `pnpm publish:packages -- --dry-run` | verify publish packaging without releasing |

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/cli` | thin CLI adapter published as `@exit-zero-labs/httpi` |
| `apps/mcp` | thin MCP stdio adapter published as `@exit-zero-labs/httpi-mcp` |
| `packages/` | shared contracts, definition loading, execution, runtime, HTTP, and utilities |
| `examples/` | public example projects that double as canonical test inputs |
| `testing/httpi/` | unit, example, E2E, publish, flow, and judge-oriented validation assets |
| `docs/` | product, architecture, roadmap, and operator guidance |

## Working with examples

The public examples are part of the product surface, not throwaway fixtures.

- keep `examples/getting-started` minimal and easy to copy
- treat `examples/pause-resume` as the canonical full workflow reference
- use `examples/api-key-body-file` for secret, auth, and body template scenarios
- when an example changes behavior, update the matching automated tests and any linked docs in the same PR

## Release-sensitive notes

Only the CLI and MCP adapters publish to npm:

- `@exit-zero-labs/httpi`
- `@exit-zero-labs/httpi-mcp`

When a change affects published behavior, packaging, or install-time documentation:

1. add or update the relevant changeset
2. run `pnpm exec changeset status`
3. run `pnpm publish:packages -- --dry-run`

## Useful documents

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) for contribution workflow and release guidance
- [`docs/architecture.md`](architecture.md) for package boundaries and runtime semantics
- [`docs/agent-guide.md`](agent-guide.md) for CLI/MCP execution guidance
- [`testing/httpi/README.md`](../testing/httpi/README.md) for automated test assets and judge checklists
- [`docs/roadmap.md`](roadmap.md) for planned work and scope guardrails
