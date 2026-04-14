<!-- @format -->

# Filesystem safety

The runtime package treats filesystem paths as a security boundary.

## Project-root containment

Runtime-owned paths are resolved from the project root and checked to stay inside it:

- `runmark/artifacts/`
- `runmark/artifacts/sessions/`
- `runmark/artifacts/history/`
- audit-export output paths

This prevents a request, cleanup operation, or audit export from wandering into unrelated directories.

## Symlink rejection

`runmark` rejects existing runtime directories and files that resolve through symlinks. That applies to the important local surfaces:

- `runmark/artifacts/`
- `runmark/artifacts/sessions/`
- `runmark/artifacts/history/`
- `runmark/artifacts/secrets.yaml`
- session ledgers and secret companions
- audit-export directory chains and pre-existing output files

If a path is unsafe, the CLI fails with a validation-style error instead of following it.

## Runtime permissions

Where the platform supports it:

- runtime directories use owner-only mode `0700`
- runtime files use owner-only mode `0600`

That includes the local `*.secret.json` companion files written next to session ledgers.

## Session write and delete ordering

Secret-bearing session state is stored with deliberate ordering:

1. write the redacted main session ledger first
2. write the secret companion second

That way an interrupted write cannot leave secret state ahead of the inspectable primary ledger.

Cleanup also deletes in the safer direction:

1. remove the secret companion first
2. remove the main session ledger second

That minimizes the chance of leaving an orphaned secret file behind after partial cleanup.

## Runtime file shapes

The runtime tree uses a predictable layout:

```text
runmark/artifacts/
├── secrets.yaml
├── reports/
├── sessions/
│   ├── <sessionId>.json
│   ├── <sessionId>.secret.json
│   ├── <sessionId>.lock
│   └── <sessionId>.cancel
└── history/
    └── <sessionId>/
        ├── manifest.json
        ├── events.jsonl
        └── steps/
```

See [`outputs-and-runtime-files.md`](outputs-and-runtime-files.md) for the practical meaning of each file.

## Paths outside `runmark/artifacts/`

Some request features can intentionally write elsewhere inside the project tree:

- `response.saveTo`
- `runmark audit export --output <path>`

Recommended practice:

- keep runtime-generated files under `runmark/artifacts/` unless you have a strong reason not to
- if you choose another project-relative path, keep it owned by the same repo and review it like any other generated output

`runmark` still rejects paths that escape the project root or reuse unsafe symlinks.
