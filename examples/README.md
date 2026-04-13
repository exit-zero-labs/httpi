<!-- @format -->

# Example projects

These projects are the public, copyable reference set for `httpi`. There is intentionally no repo-root sample project anymore; all checked-in references live here. They are also wired into the automated test suite so the examples stay valid and runnable.

Each example intentionally checks in a minimal `httpi/artifacts/` skeleton so you can see where local secrets, sessions, and request artifacts live. In normal projects, `httpi/artifacts/` should stay Git-ignored apart from the tracked `.gitkeep` placeholders.

| Example | What it shows | Primary automated coverage |
| --- | --- | --- |
| [`getting-started`](getting-started) | smallest project that validates, describes, and runs a single request | `testing/httpi/httpi.examples.test.mjs` |
| [`multi-env-smoke`](multi-env-smoke) | switching the same run between `dev` and `staging` env files | `testing/httpi/httpi.examples.test.mjs` |
| [`pause-resume`](pause-resume) | login, secret extraction, parallel reads, pause, artifacts, and resume | `testing/httpi/httpi.e2e.test.mjs` plus `testing/httpi/httpi.unit.test.mjs` |
| [`api-key-body-file`](api-key-body-file) | `$ENV` secrets, header auth, `body.file`, run inputs, and step outputs | `testing/httpi/httpi.examples.test.mjs` |
| [`basic-auth-crud`](basic-auth-crud) | basic auth, local secrets, request JSON bodies, and CRUD sequencing | `testing/httpi/httpi.examples.test.mjs` |
| [`ecommerce-checkout`](ecommerce-checkout) | a multi-step checkout flow with API-key auth, body templates, and extracted IDs | `testing/httpi/httpi.examples.test.mjs` |
| [`incident-runbook`](incident-runbook) | ops-style parallel diagnostics, a human pause, and a safe resume into mutation | `testing/httpi/httpi.examples.test.mjs` |
| [`failure-recovery`](failure-recovery) | failed sessions, request history, and retrying work with `resume` after an upstream recovers | `testing/httpi/httpi.examples.test.mjs` |

Use any example directly with `--project-root`:

```bash
httpi validate --project-root examples/getting-started
httpi describe --run smoke --project-root examples/getting-started
httpi run --run smoke --project-root examples/getting-started
```
