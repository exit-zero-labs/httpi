---
"@exit-zero-labs/runmark": minor
---

Quick-authoring verbs: `runmark new`, `runmark edit`, `runmark lint`.

- `runmark new <request|run|env|block> <id>` scaffolds pure-YAML definitions at the canonical path. Ids are preserved verbatim in the filename so runmark's path-derived ids stay consistent. Refuses to overwrite existing files.
- `runmark edit <definitionId>` resolves the canonical tracked path for a request, run, or env id. Auto-opens in `$EDITOR`/`$VISUAL` when set, prints the path otherwise.
- `runmark lint` runs the validator as a CI-friendly command and exits non-zero on any error diagnostic.
- New export: `scaffoldDefinition` from `@exit-zero-labs/runmark-execution`.
