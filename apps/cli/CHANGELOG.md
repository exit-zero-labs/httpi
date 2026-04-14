# @exit-zero-labs/runmark

Package-local mirror of the canonical repo changelog for the published Runmark CLI and MCP package.

## 0.5.0

### Minor Changes

- b43b3ad: Require `projectRoot` on every `runmark mcp` tool call.

  MCP servers are often launched outside the target repository, so tool calls no
  longer fall back to server cwd-based project discovery. MCP clients must now
  send `projectRoot` on every tool invocation, pointing at the repository
  directory that contains `runmark/config.yaml`.

- Add demo-first onboarding with `runmark demo start`, scaffold new projects and
  checked-in examples against the bundled local demo server by default, return
  structured `nextSteps` from `runmark init`, and switch new config scaffolds to
  metadata-only response capture by default.

- Add lifecycle commands for `runmark audit export` plus `runmark clean`,
  including MCP parity tools for redacted audit summaries and runtime-state
  cleanup.

- Split secret-bearing session state into owner-only `*.secret.json` companion
  files, keep canonical session ledgers redacted, and harden artifact export and
  runtime cleanup with project-root and symlink safety checks.

- Rebuild the public docs and package surfaces around the demo-first quickstart,
  inspect-and-resume flows, examples, CI and team adoption, security and
  privacy, and the CLI/YAML/error-code reference pages.

## 0.3.0

### Minor Changes

- Consolidate runtime state under `runmark/artifacts/`, replace `responses/` with
  `history/`, and store canonical per-attempt `request.json` artifacts that keep
  the full sent request plus the recorded response or error outcome.

- Make `examples/` the only checked-in reference surface, remove the repo-root
  sample project, and add a broader example catalog covering multi-env smoke,
  basic-auth CRUD, ecommerce checkout, incident runbooks, and failure recovery.

## 0.2.0

### Minor Changes

- 567e696: Consolidate the MCP adapter into the CLI package.
  `@exit-zero-labs/runmark-mcp` is no longer published; its functionality ships
  inside `@exit-zero-labs/runmark` as the `runmark mcp` subcommand, which starts
  the same stdio MCP server backed by the same shared engine.

  **Breaking change for MCP client configs.** Update from:

  ```json
  { "command": "runmark-mcp", "args": [] }
  ```

  to:

  ```json
  { "command": "runmark", "args": ["mcp"] }
  ```

  or, without a global install:

  ```json
  { "command": "npx", "args": ["-y", "@exit-zero-labs/runmark", "mcp"] }
  ```

  The MCP SDK is lazy-imported inside the `mcp` subcommand, so CLI-only users
  pay no startup cost for it. All 14 tools (`list_definitions`,
  `validate_project`, `describe_request`, `describe_run`, `run_definition`,
  `resume_session`, `get_session_state`, `list_artifacts`, `read_artifact`,
  `get_stream_chunks`, `cancel_session`, `explain_variables`,
  `export_audit_summary`, `clean_runtime_state`) remain registered with
  identical input/output schemas.

## 0.1.2

### Patch Changes

- 7d40eaa: Improve CLI and MCP discoverability, harden runtime path validation
  for artifacts, expand validation and publish-path coverage, and refactor core
  execution and definitions internals for maintainability.
