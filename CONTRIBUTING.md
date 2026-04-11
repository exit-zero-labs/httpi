<!-- @format -->

# Contributing to httpi

Thanks for contributing to `httpi`.

## Before you start

- read [`README.md`](README.md)
- read [`docs/product.md`](docs/product.md)
- read [`docs/architecture.md`](docs/architecture.md)
- check open issues or start a discussion before large changes

## Local setup

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm build
```

## Working conventions

- use TypeScript strict mode patterns
- prefer named exports
- keep files in kebab-case
- keep CLI and MCP packages thin; move shared behavior into `packages/`
- do not commit secrets or runtime artifacts from `.httpi/`
- keep documentation aligned with behavior changes

## Pull requests

Please keep PRs focused and easy to review.

For non-trivial changes:

1. explain the problem being solved
2. link the relevant issue or discussion when available
3. describe how the change was validated
4. update docs when behavior or architecture changed

## Commits

Use Conventional Commits where practical:

```text
feat(cli): add request listing command
fix(runtime): block unsafe resume on drift
docs: refine architecture overview
```

## Scope guidance

Good early contributions include:

- documentation improvements
- fixture and judge assets under `testing/httpi/`
- schema and validation work
- runtime safety and redaction improvements
- CLI and MCP parity improvements
