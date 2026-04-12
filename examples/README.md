<!-- @format -->

# Example projects

These projects are the public, copyable reference set for `httpi`. They are also wired into the automated test suite so the checked-in examples stay valid and runnable.

Each example intentionally checks in a minimal `.httpi/` skeleton so you can see where local secrets, sessions, and response artifacts live. In normal projects, `.httpi/` should still stay out of Git.

| Example | What it shows | Primary automated coverage |
| --- | --- | --- |
| [`getting-started`](getting-started) | smallest project that validates, describes, and runs a single request | `testing/httpi/httpi.examples.test.mjs` |
| [`pause-resume`](pause-resume) | login, secret extraction, parallel reads, pause, artifacts, and resume | `testing/httpi/httpi.e2e.test.mjs` plus `testing/httpi/httpi.unit.test.mjs` |
| [`api-key-body-file`](api-key-body-file) | `$ENV` secrets, header auth, `body.file`, run inputs, and step outputs | `testing/httpi/httpi.examples.test.mjs` |

Use any example directly with `--project-root`:

```bash
httpi validate --project-root examples/getting-started
httpi describe --run smoke --project-root examples/getting-started
httpi run --run smoke --project-root examples/getting-started
```
