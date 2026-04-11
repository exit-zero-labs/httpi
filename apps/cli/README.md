# @exit-zero-labs/httpi

CLI package for `httpi`, the file-based HTTP workflow runner for humans and AI agents.

## Install

```bash
npm install -g @exit-zero-labs/httpi
httpi --version
```

## Quick start

```bash
httpi init
httpi validate
httpi describe --run smoke
httpi explain variables --request ping
httpi run --run smoke
```

When `--project-root` is omitted, the CLI discovers the nearest `httpi/config.yaml`.

## What this package does

- scaffolds a tracked `httpi/` project with `httpi init`
- validates definitions before execution
- runs requests and multi-step runs
- persists sessions and artifacts under `.httpi/`
- lets you inspect artifacts and explicitly resume paused or failed runs

## More docs

- repository overview: <https://github.com/exit-zero-labs/httpi#readme>
- agent-oriented guidance: <https://github.com/exit-zero-labs/httpi/blob/main/docs/agent-guide.md>
- technical architecture: <https://github.com/exit-zero-labs/httpi/blob/main/docs/architecture.md>
