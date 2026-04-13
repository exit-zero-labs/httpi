# Changelog

This changelog tracks user-visible changes for the current `0.3.x` line.

## 0.3.0

- consolidate runtime state under `httpi/artifacts/`, replace `responses/` with `history/`, and capture canonical per-attempt `request.json` artifacts with recorded response/error outcomes
- make `examples/` the only checked-in reference set, remove the repo-root sample project, and expand the catalog with multi-env, CRUD, ecommerce, incident, and failure-recovery examples
- prepare scoped npm publishing for the `@exit-zero-labs/httpi` CLI and `@exit-zero-labs/httpi-mcp` adapter with Changesets-based release automation
- keep the shared engine workspace packages private while publishing standalone CLI and MCP install surfaces
- switch npm publishing from repository tokens to GitHub Actions trusted publishing via OIDC

## 0.1.0

- initial file-based workflow model with tracked request intent and local runtime artifacts
- shared execution engine used by both the CLI and MCP adapters
- request/run validation, describe, explain, run, session, artifact, and resume flows
- pause/resume with definition drift checks and persisted local session state
- artifact capture with header/value redaction and local runtime safety checks
- JSON Schema and IDE support for tracked YAML authoring
- focused unit coverage plus fixture-backed CLI/MCP end-to-end coverage
