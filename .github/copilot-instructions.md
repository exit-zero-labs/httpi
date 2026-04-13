<!-- @format -->

# GitHub Copilot Instructions for httpi

Primary repository guidance lives in [`AGENTS.md`](../AGENTS.md) and [`.ai/AI.md`](../.ai/AI.md).

Key rules:

- keep `apps/cli` as a thin adapter — it exposes both the `httpi` CLI and the `httpi mcp` stdio MCP server
- keep tracked request intent in `httpi/` and runtime state in `httpi/artifacts/`
- do not add secret literals to tracked files
- prefer path-derived IDs and explicit schemas at public boundaries
- put judge-oriented validation assets under `testing/httpi/`
