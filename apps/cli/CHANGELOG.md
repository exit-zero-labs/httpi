# @exit-zero-labs/httpi

## 0.2.0

### Minor Changes

- 567e696: Consolidate the MCP adapter into the CLI package. `@exit-zero-labs/httpi-mcp`
  is no longer published — its functionality ships inside `@exit-zero-labs/httpi`
  as the `httpi mcp` subcommand, which starts the same stdio MCP server backed
  by the same shared engine.

  **Breaking change for MCP client configs.** Update from:

  ```json
  { "command": "httpi-mcp", "args": [] }
  ```

  to:

  ```json
  { "command": "httpi", "args": ["mcp"] }
  ```

  or, without a global install:

  ```json
  { "command": "npx", "args": ["-y", "@exit-zero-labs/httpi", "mcp"] }
  ```

  The MCP SDK is lazy-imported inside the `mcp` subcommand, so CLI-only users
  pay no startup cost for it. All 12 tools (`list_definitions`,
  `validate_project`, `describe_request`, `describe_run`, `run_definition`,
  `resume_session`, `get_session_state`, `list_artifacts`, `read_artifact`,
  `get_stream_chunks`, `cancel_session`, `explain_variables`) remain registered
  with identical input/output schemas.

## 0.1.2

### Patch Changes

- 7d40eaa: Improve CLI and MCP discoverability, harden runtime path validation for artifacts, expand validation and publish-path coverage, and refactor core execution and definitions internals for maintainability.
