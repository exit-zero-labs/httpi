<!-- @format -->

# CI and team adoption

`runmark` works best as a repo-local validation tool: tracked request intent lives next to the code it exercises, and runtime evidence stays local to each run.

## Prefer local installs in shared repos

For team repos and CI, prefer a repo-local package install over a global one:

```bash
npm install --save-dev @exit-zero-labs/runmark
npx runmark validate
```

Equivalent local-bin entrypoints also work:

- `pnpm exec runmark`
- `bunx runmark`
- `yarn run runmark`

## Minimal GitHub Actions workflow

This example assumes `@exit-zero-labs/runmark` is already in `devDependencies` and that the project under test contains a `runmark/` directory:

```yaml
name: runmark

on:
  pull_request:
  push:
    branches: [main]

jobs:
  validate-api-workflows:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx runmark validate
      - run: npx runmark run --run smoke --reporter json:runmark/artifacts/reports/smoke.json
      - if: always()
        run: npx runmark audit export --output runmark/artifacts/reports/audit.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: runmark-artifacts
          path: |
            runmark/artifacts/history/
            runmark/artifacts/reports/
            runmark/artifacts/sessions/*.json
            !runmark/artifacts/sessions/*.secret.json
            !runmark/artifacts/secrets.yaml
```

This upload pattern keeps the redacted runtime evidence but excludes the local secret file and secret companion session files.

If you are using the bundled demo server in CI, start it in the background before `validate` and `run`:

```bash
npx runmark demo start > /tmp/runmark-demo.log 2>&1 &
```

## Exit-code handling

`runmark run` intentionally uses a small exit-code set:

| Exit code | Meaning | Typical next step |
| --- | --- | --- |
| `0` | success | keep going |
| `1` | execution or expectation failure | inspect session + artifacts |
| `2` | validation or configuration failure | fix the tracked file, flags, or local wiring |
| `3` | unsafe resume or lock conflict | inspect drift / lock state, then retry or start a fresh run |
| `4` | unexpected internal error | treat as tool failure and capture logs |

Use `validate` as an earlier gate when you want to fail fast on YAML, schema, or path issues before any HTTP goes out.

## Secrets in CI

Keep tracked files free of secret literals. In automation, use one of these patterns:

1. reference environment variables directly in tracked files with `$ENV:NAME`
2. materialize `runmark/artifacts/secrets.yaml` just before execution, then remove it afterward

Simple GitHub Actions pattern:

```bash
mkdir -p runmark/artifacts
trap 'rm -f runmark/artifacts/secrets.yaml' EXIT
cat > runmark/artifacts/secrets.yaml <<EOF
apiToken: ${RUNMARK_API_TOKEN}
devPassword: ${RUNMARK_DEV_PASSWORD}
EOF

npx runmark run --run smoke
```

If your workflow uploads runtime evidence, exclude `runmark/artifacts/secrets.yaml` and `runmark/artifacts/sessions/*.secret.json` from the artifact paths.

For external secret managers, use [`external-secret-sources.md`](external-secret-sources.md).

## Reviewing `runmark/` changes in pull requests

Review `runmark/` diffs like product code, not like disposable test fixtures:

- are env files non-secret and environment-specific?
- are request and run IDs path-derived and stable?
- do new mutating steps have an intentional pause, confirmation policy, or other guard?
- do expectation changes reflect a real contract update rather than papering over a regression?
- are extracted secret values marked with `secret: true`?
- did the author avoid committing runtime files outside `.gitkeep` placeholders?

## Sharing runtime evidence safely

When someone else needs to inspect a run:

- prefer `runmark audit export` for a redacted summary
- attach `runmark/artifacts/history/<sessionId>/manifest.json` or selected redacted artifacts when needed
- if CI uploads runtime files, exclude `runmark/artifacts/secrets.yaml` and `runmark/artifacts/sessions/*.secret.json`
- do **not** share `runmark/artifacts/sessions/*.secret.json` or `runmark/artifacts/secrets.yaml`

## Monorepos and agents

When the current working directory is not the repo that owns `runmark/config.yaml`, pass `--project-root` on the CLI or `projectRoot` in MCP tool calls. That keeps CI jobs, monorepo scripts, and coding agents aligned on the same project boundary.
