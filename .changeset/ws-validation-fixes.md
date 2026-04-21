---
"@exit-zero-labs/runmark": patch
---

Validation pass fixes on top of the quickstart/reporters/authoring/evals work:

- `runmark describe` now auto-picks the sole run when neither `--request` nor `--run` is supplied, matching the behaviour already documented for `runmark run`.
- `runmark quickstart --port <n>` now rewrites the baseUrl in the just-scaffolded `runmark/env/dev.env.yaml` so later `runmark run` invocations resolve the same demo URL.
- Demo server listen failures (including `EADDRINUSE`) now reject their start promise instead of crashing the process via an unhandled `error` event, letting quickstart's friendly diagnostic fire.
- Block scaffolder templates now match the live block schemas: `runmark new block foo --block-kind headers|auth` produces YAML that `runmark validate` accepts (top-level `headers:` / `auth:` keys, correct schema hint).
- Eval scaffolder no longer points at a non-existent `eval.schema.json`; the placeholder comment references `runmark help eval` instead.
- Eval dataset loader: strip UTF-8 BOM, reject empty datasets, error on unclosed CSV quotes, and preserve whitespace inside quoted CSV cells.
- CI reporters: GitHub Actions annotations now percent-encode `\n`/`\r` (so multi-line messages keep their line breaks), and the TAP YAML block JSON-encodes error messages to stay YAML-valid when they contain colons, hashes, or newlines.
- `writeSessionSummaryArtifacts` now uses atomic tmp+rename writes so crashes can't leave a truncated `summary.json`.
- `maybeWriteReporter` warns and skips when two `--reporter` specs resolve to the same path instead of silently overwriting the earlier format.
- README core-workflow table and `runmark help new` now list `eval`, `new`, `edit`, and `lint`; the `NEW_ARGS_REQUIRED` error message includes `eval`.
