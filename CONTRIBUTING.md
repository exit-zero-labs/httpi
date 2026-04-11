<!-- @format -->

# Contributing to httpi

Thanks for contributing to `httpi`.

## Before you start

- read [`README.md`](README.md)
- read [`docs/product.md`](docs/product.md)
- read [`docs/architecture.md`](docs/architecture.md)
- scan [`docs/roadmap.md`](docs/roadmap.md) for the current priorities so you do not duplicate planned work
- read [`testing/httpi/README.md`](testing/httpi/README.md) before changing fixtures, judge assets, or end-to-end behavior
- check open issues before large changes so your proposal lines up with the roadmap and active discussions

## Local setup

```bash
pnpm install
pnpm check
pnpm test
```

## Local development loop

For most non-trivial changes, the expected local loop is:

1. make the code or docs change
2. run `pnpm check`
3. run `pnpm test`
4. exercise the fixture project under `testing/httpi/fixtures/basic-project` when the change affects CLI, MCP, runtime semantics, or documentation examples

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

Changes that touch the public surface should update the relevant canonical documents in the same PR:

- `README.md` for repository entrypoint and quick-start behavior
- `CHANGELOG.md` for user-visible changes in the current release line
- `docs/product.md` for user-facing product promises
- `docs/architecture.md` for technical contracts and semantics
- `packages/contracts/schemas/` and `.vscode/settings.json` when tracked YAML authoring rules change
- `testing/httpi/README.md` and `testing/httpi/judge/basic-flow.md` when acceptance behavior changes

## Release flow

Published packages use the `@exit-zero-labs/*` scope.

For changes that should ship to npm:

1. run `pnpm changeset` and describe the user-visible package change
2. merge the PR to `main`
3. let `.github/workflows/release.yml` open or update the Changesets release PR
4. merge that release PR to publish the new package versions once `NPM_TOKEN` is configured

Repository maintainers need an `NPM_TOKEN` GitHub Actions secret with publish access to the `@exit-zero-labs` npm organization before the release workflow can publish packages. Without it, the workflow still opens or updates the release PR and a later `workflow_dispatch` run can publish once the secret is in place.

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

Maintainers favor small, reviewable changes that strengthen the current v0 story. If you are proposing a larger feature, anchor it to the roadmap and explain how it preserves the existing guardrails around thin adapters, tracked intent, and explicit runtime behavior.
