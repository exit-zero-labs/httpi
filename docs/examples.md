<!-- @format -->

# Runmark examples

The example projects under [`examples/`](../examples/README.md) are part of the public product surface. They are maintained reference repos with automated coverage behind them.

Unless an example README says otherwise, start the bundled demo API once and leave it running:

```bash
runmark demo start
```

## Recommended order

If you are new to `runmark`, this path gives the clearest progression:

1. [`examples/getting-started`](../examples/getting-started) — smallest possible project
2. [`examples/pause-resume`](../examples/pause-resume) — the canonical inspect / pause / resume flow
3. [`examples/failure-recovery`](../examples/failure-recovery) — expectation failures, runtime evidence, and recovery

After that, pick the example that matches the workflow shape you care about.

## Example catalog

| Example | Best for | What it shows |
| --- | --- | --- |
| [`getting-started`](../examples/getting-started) | first success | one env, one request, one run |
| [`pause-resume`](../examples/pause-resume) | understanding the full workflow | login, secret extraction, parallel reads, explicit pause, artifact inspection, and resume |
| [`failure-recovery`](../examples/failure-recovery) | failure handling | failed sessions, artifact history, and re-running after investigation |
| [`multi-env-smoke`](../examples/multi-env-smoke) | environment reuse | one run reused across multiple env files |
| [`api-key-body-file`](../examples/api-key-body-file) | body templates and API-key auth | `$ENV` auth, request bodies from files, and extracted outputs |
| [`basic-auth-crud`](../examples/basic-auth-crud) | local-secret auth plus mutation | basic auth, JSON bodies, and sequential CRUD |
| [`ecommerce-checkout`](../examples/ecommerce-checkout) | longer business workflows | cart creation, checkout, extracted IDs, and follow-up verification |
| [`incident-runbook`](../examples/incident-runbook) | operator-style workflows | parallel diagnostics, pause points, and guarded mutation |

## Copying patterns into your own repo

When you copy from an example:

- keep `runmark/` tracked and keep `runmark/artifacts/` Git-ignored
- copy the related request, run, body, and block files together
- keep IDs path-derived instead of inventing a second naming system
- rerun `runmark validate` after every structural edit
- keep secrets in `runmark/artifacts/secrets.yaml`, `$ENV:NAME`, or an external secret source rather than checked-in YAML

For team and CI usage after the first successful run, continue with [`ci-and-team-adoption.md`](ci-and-team-adoption.md).
