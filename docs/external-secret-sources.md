<!-- @format -->

# External secret sources

For local development, `runmark/artifacts/secrets.yaml` is the simplest secret bridge.

For CI and production-like automation, prefer one of these patterns:

1. reference injected environment variables directly with `$ENV:NAME`
2. materialize `runmark/artifacts/secrets.yaml` just before execution from your secret manager

The key rule is the same in every environment: keep secret literals out of tracked `runmark/` files.

## Recommended production posture

Use `secrets.yaml` as an **ephemeral runtime file**, not as a long-lived checked-in secret store:

- create it during the job or shell session
- run `runmark`
- delete it when the job is done

If your secret manager already injects environment variables cleanly, prefer `$ENV:NAME` and skip the local alias file entirely.

If your CI system uploads runtime evidence, exclude `runmark/artifacts/secrets.yaml` and `runmark/artifacts/sessions/*.secret.json` from the uploaded paths.

## GitHub Actions secrets

```bash
mkdir -p runmark/artifacts
trap 'rm -f runmark/artifacts/secrets.yaml' EXIT
cat > runmark/artifacts/secrets.yaml <<EOF
apiToken: ${RUNMARK_API_TOKEN}
devPassword: ${RUNMARK_DEV_PASSWORD}
EOF

npx runmark run --run smoke
```

## 1Password or Doppler-style CLIs

Materialize the local alias file from the manager's CLI:

```bash
mkdir -p runmark/artifacts
trap 'rm -f runmark/artifacts/secrets.yaml' EXIT
cat > runmark/artifacts/secrets.yaml <<EOF
apiToken: $(op read 'op://Engineering/runmark/api token')
devPassword: $(op read 'op://Engineering/runmark/dev password')
EOF

npx runmark run --run smoke
```

## Vault-style CLIs

Resolve secrets to environment variables first, then write the runtime file:

```bash
export RUNMARK_API_TOKEN="$(vault kv get -field=apiToken secret/apps/runmark)"
export RUNMARK_DEV_PASSWORD="$(vault kv get -field=devPassword secret/apps/runmark)"

mkdir -p runmark/artifacts
trap 'rm -f runmark/artifacts/secrets.yaml' EXIT
cat > runmark/artifacts/secrets.yaml <<EOF
apiToken: ${RUNMARK_API_TOKEN}
devPassword: ${RUNMARK_DEV_PASSWORD}
EOF

npx runmark run --run smoke
```

## Cloud secret managers

The same pattern works with AWS, GCP, Azure, or any platform that can hand the job a secret value:

1. fetch the secret with the platform CLI or workload identity
2. export it into the shell or write it straight into `runmark/artifacts/secrets.yaml`
3. run `runmark`
4. delete the file after the job

## When to use `$ENV:NAME` instead

Use direct environment-variable references when:

- the secret naturally belongs to one request field or auth block
- your CI system already injects the variable cleanly
- you do not need a reusable local alias name inside `{{secrets.*}}`

Use an ephemeral `secrets.yaml` when:

- you want the same alias names locally and in CI
- multiple requests or runs share the same secret names
- you want to keep tracked YAML readable while still avoiding committed secret values

## Related docs

- [`security-and-privacy.md`](security-and-privacy.md)
- [`ci-and-team-adoption.md`](ci-and-team-adoption.md)
