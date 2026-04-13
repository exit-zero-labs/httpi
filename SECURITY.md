<!-- @format -->

# Security Policy

## Supported versions

`httpi` is pre-1.0. The latest code on the default branch is the only supported version for security reporting and fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Instead:

1. use GitHub private vulnerability reporting if it is enabled for the repository
2. otherwise contact the maintainers privately through GitHub

When reporting an issue, include:

- a clear description of the problem
- affected files or commands if known
- reproduction steps
- expected impact

## Security notes for operators

- `httpi` keeps tracked intent in `httpi/` and runtime-only state in `httpi/artifacts/`; `httpi/artifacts/` should stay Git-ignored apart from tracked `.gitkeep` placeholders.
- Runtime secrets belong in `httpi/artifacts/secrets.yaml` or supported `$ENV:NAME` references. Missing `$ENV:NAME` errors intentionally reveal the variable name, but never the secret value itself.
- Session lock files live under `httpi/artifacts/sessions/`. If a process crashes and leaves a stale `<sessionId>.lock` behind, remove that lock file only after you confirm no other `httpi` process is still operating on the same session.

## What to expect

Maintainers will triage the report, confirm impact, and decide on the fix and disclosure process. Please avoid public disclosure until the issue has been reviewed and a mitigation path is ready.
