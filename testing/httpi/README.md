<!-- @format -->

# testing/httpi

This directory contains the fixtures, flows, end-to-end tests, and judge-oriented validation assets used to test `httpi` itself and to support LLM-as-a-judge workflows.

The goal is not only to prove that the engine works, but also to make the expected validation flow easy for humans and coding agents to inspect and repeat.

## Current layout

```text
fixtures/          sample payloads, env files, and canonical definition sets
flows/             scenario writeups and flow notes as coverage grows
judge/             pass/fail checklists and validation guidance for coding agents
httpi.unit.test.mjs focused engine and CLI contract coverage
httpi.e2e.test.mjs CLI and MCP end-to-end coverage against the fixture project
```

## Included assets

- `fixtures/basic-project/` exercises envs, blocks, body files, request definitions, runs, pause/resume, and secrets
- `judge/basic-flow.md` captures the expected end-to-end acceptance behavior
- `httpi.unit.test.mjs` pins focused behavior such as extraction taint, interpolation, session redaction, and CLI exit-code mapping
- `httpi.e2e.test.mjs` covers validate, describe, explain, run, session/artifact inspection, pause/resume, redaction, traversal safety, and CLI/MCP parity

## Fast manual validation loop

Use the fixture project when you want to exercise the current v0 workflow by hand:

```bash
pnpm build
node apps/cli/dist/index.js validate --project-root testing/httpi/fixtures/basic-project
node apps/cli/dist/index.js describe --run smoke --project-root testing/httpi/fixtures/basic-project
node apps/cli/dist/index.js explain variables --request ping --project-root testing/httpi/fixtures/basic-project
```

For the full paused-run workflow, the E2E test spins up a mock server and rewrites the fixture environment at runtime so the commands exercise a real HTTP flow safely.

## When to update this directory

If a change affects user-visible validation behavior, update all of the following together:

1. the fixture project under `fixtures/`
2. the executable assertions in `httpi.e2e.test.mjs`
3. the human-and-agent acceptance checklist in `judge/basic-flow.md`
