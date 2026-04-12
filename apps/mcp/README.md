# @exit-zero-labs/httpi-mcp

MCP stdio adapter for `httpi`, the file-based HTTP workflow runner for humans and AI agents.

## Install

```bash
npm install -g @exit-zero-labs/httpi-mcp
httpi-mcp --version
```

## Run the server

```bash
httpi-mcp --help
httpi-mcp
```

`httpi-mcp` serves one `httpi` project over stdio using the same execution engine as the CLI.

## Generic MCP client configuration

```json
{
  "command": "httpi-mcp",
  "args": []
}
```

## Core tools

- `list_definitions`
- `validate_project`
- `describe_request`
- `describe_run`
- `run_definition`
- `resume_session`
- `get_session_state`
- `list_artifacts`
- `read_artifact`
- `explain_variables`

`run_definition` accepts exactly one of `requestId` or `runId`.

## Support

Support development via GitHub Sponsors or Open Collective:

- <https://github.com/sponsors/exit-zero-labs>
- <https://opencollective.com/exit-zero-labs>

GitHub Sponsors is the primary recurring path. Open Collective is the secondary path for one-time support and public budget visibility. Repo-level support notes live at <https://github.com/exit-zero-labs/httpi/blob/main/docs/support.md>.

## More docs

- repository overview: <https://github.com/exit-zero-labs/httpi#readme>
- agent-oriented guidance: <https://github.com/exit-zero-labs/httpi/blob/main/docs/agent-guide.md>
- technical architecture: <https://github.com/exit-zero-labs/httpi/blob/main/docs/architecture.md>
