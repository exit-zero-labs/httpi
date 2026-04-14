# @exit-zero-labs/runmark

Run tracked HTTP workflows from YAML. This package ships both the `runmark` CLI and the `runmark mcp` stdio server in one install.

## Install

Global install:

```bash
npm install -g @exit-zero-labs/runmark
runmark --version
```

Repo-local or CI install:

```bash
npm install --save-dev @exit-zero-labs/runmark
npx runmark --version
```

Use the repo-local form when you want the Runmark version pinned in `package.json` and your lockfile. The examples below use `npx`; if you installed globally, drop the prefix.

## Quick start

```bash
mkdir demo-api
cd demo-api
npx runmark init
npx runmark demo start
```

In a second terminal:

```bash
npx runmark validate
npx runmark describe --run smoke
npx runmark explain variables --request ping
npx runmark run --run smoke
```

`runmark init` creates a tracked `runmark/` project, prints the absolute project path plus the files it created, and returns structured `nextSteps`. New scaffolds point at the bundled demo server on `http://127.0.0.1:4318`, so you can get to a first successful run without provisioning extra infrastructure first.

## What this package gives you

- `runmark init`, `validate`, `describe`, `explain`, and `run`
- inspect, resume, and cancel flows for paused or interrupted sessions
- `runmark audit export` for redacted summaries and `runmark clean` for retention-driven cleanup
- local runtime artifacts under `runmark/artifacts/`
- the same execution engine behind both the CLI and `runmark mcp`

## MCP

There is no separate `runmark-mcp` package. Start the MCP server from this package:

```json
{
  "command": "npx",
  "args": ["-y", "@exit-zero-labs/runmark", "mcp"]
}
```

If you installed globally, use:

```json
{
  "command": "runmark",
  "args": ["mcp"]
}
```

Every MCP tool call must include `projectRoot` pointing at the repository directory that contains `runmark/config.yaml`. This is required in 0.5.0 and later because MCP servers often start outside the target repository.

## Runtime files and secret handling

- tracked intent lives under `runmark/`
- runtime output lives under `runmark/artifacts/`
- shareable session ledgers live under `runmark/artifacts/sessions/*.json`
- secret-bearing companion state is stored separately in owner-only `runmark/artifacts/sessions/*.secret.json`
- do not upload `runmark/artifacts/sessions/*.secret.json` or `runmark/artifacts/secrets.yaml` from CI artifacts

For safe CI evidence, prefer `npx runmark audit export --output runmark/artifacts/reports/audit.json` plus `runmark/artifacts/history/`, `runmark/artifacts/reports/`, and the redacted `runmark/artifacts/sessions/*.json` ledgers.

## Docs

- docs site: <https://runmark.exitzerolabs.com>
- quickstart: <https://runmark.exitzerolabs.com/guides/quickstart/>
- inspect and resume: <https://runmark.exitzerolabs.com/guides/inspect-and-resume/>
- examples: <https://runmark.exitzerolabs.com/guides/examples/>
- CI and team adoption: <https://runmark.exitzerolabs.com/guides/ci-and-team-adoption/>
- security and privacy: <https://runmark.exitzerolabs.com/trust/security-and-privacy/>
- CLI reference: <https://runmark.exitzerolabs.com/reference/cli-reference/>
- YAML reference: <https://runmark.exitzerolabs.com/reference/yaml-reference/>
- changelog: <https://runmark.exitzerolabs.com/reference/changelog/>

## Support

Support development via GitHub Sponsors or Open Collective:

- <https://github.com/sponsors/exit-zero-labs>
- <https://opencollective.com/exit-zero-labs>

GitHub Sponsors is the primary recurring path. Open Collective is the secondary path for one-time support and public budget visibility. Repo-level support notes live at <https://runmark.exitzerolabs.com/reference/support/>.
