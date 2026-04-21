---
"@exit-zero-labs/runmark": patch
---

Close remaining validation-pass gaps:

- Ship a real `eval.schema.json` under `packages/contracts/schemas/` (also wired into the package's `exports`) so YAML language servers get autocomplete and validation on `runmark/evals/*.eval.yaml`. The scaffolder's `# yaml-language-server: $schema=...` hint is no longer a 404.
- `runmark edit <id>` now resolves block and eval ids in addition to requests/runs/envs. Previously a freshly scaffolded block or eval couldn't be opened via `edit`.
- `runmark help lint` now explains that `lint` is a CI-facing alias of `validate` (identical output) so users understand when to pick which.
- Eval JSONL loader: sharper error when a row is an array or non-object.
- Tighten `runmark edit` error copy to mention all five kinds it searches.
