<!-- @format -->

# GitHub Copilot Instructions for httpi

Primary repository guidance lives in [`AGENTS.md`](../AGENTS.md) and [`.ai/AI.md`](../.ai/AI.md).

Key rules:

- keep `apps/cli` and `apps/mcp` as thin adapters
- keep tracked request intent in `httpi/` and runtime state in `.httpi/`
- do not add secret literals to tracked files
- prefer path-derived IDs and explicit schemas at public boundaries
- put judge-oriented validation assets under `testing/httpi/`
