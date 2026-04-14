<!-- @format -->

# Inspect and resume runs

`runmark` is built around an inspectable execution loop:

1. run a request or workflow
2. inspect the persisted session and artifacts
3. resume only when the next step is still safe

That matters most when a run pauses on purpose or fails partway through.

## Canonical paused-run flow

The clearest example is [`examples/pause-resume`](../examples/pause-resume). With the bundled demo API running, the main loop is:

```bash
runmark demo start
runmark run --run smoke --project-root examples/pause-resume
```

A paused run looks like this:

```json
{
  "session": {
    "sessionId": "run-<timestamp>-<id>",
    "state": "paused",
    "nextStepId": "touch-user",
    "pausedReason": "Inspect fetched artifacts before mutation",
    "stepOutputs": {
      "login": { "sessionValue": "[REDACTED]" },
      "get-user": { "userName": "Ada" },
      "list-orders": { "firstOrderId": "ord_1" }
    }
  },
  "diagnostics": []
}
```

What you should see:

- `session.state` is `paused`
- `nextStepId` tells you which step would run next
- `stepOutputs` already includes usable non-secret values plus redacted secret-bearing ones
- `diagnostics` stays empty because the run is paused intentionally, not broken

## Inspect before continuing

Use the session and artifact commands before you resume:

```bash
runmark session show <sessionId> --project-root examples/pause-resume
runmark artifacts list <sessionId> --project-root examples/pause-resume
runmark artifacts read <sessionId> steps/login/attempt-1/request.json --project-root examples/pause-resume
```

These commands answer different questions:

- `session show` returns the persisted session ledger, including `stepRecords`, artifact paths, and any drift diagnostics that matter for resume
- `artifacts list` returns manifest entries so you can see what was captured
- `artifacts read` returns one captured artifact with redaction applied

## Resume after inspection

When the paused state still looks correct, continue explicitly:

```bash
runmark resume <sessionId> --project-root examples/pause-resume
```

Successful resume output looks like:

```json
{
  "session": {
    "sessionId": "run-<timestamp>-<id>",
    "state": "completed",
    "runId": "smoke"
  },
  "diagnostics": []
}
```

## What failure looks like

The checked-in [`examples/failure-recovery`](../examples/failure-recovery) project shows the other common state:

```bash
runmark run --run recover-report --project-root examples/failure-recovery
```

Typical failed output:

```json
{
  "session": {
    "sessionId": "run-<timestamp>-<id>",
    "state": "failed",
    "nextStepId": "fetch-report",
    "failureReason": "Assertion failed: status equals expected 200 but got 503."
  },
  "diagnostics": [
    {
      "code": "EXPECTATION_FAILED",
      "file": "runmark/requests/recovery/fetch-report.request.yaml",
      "line": 7,
      "message": "status equals: expected 200, got 503"
    }
  ]
}
```

What you should see:

- `session.state` is `failed`
- `failureReason` is human-readable
- `diagnostics` points at the tracked file and field that failed
- the process exits with code `1` because the HTTP run completed but the expectation did not

## When to resume and when to start fresh

Resume when:

- the session is `paused` or `failed`
- the tracked definitions still match the stored snapshot
- no other process still owns the session lock

Start a fresh run when:

- you changed tracked request, run, env, or block files after the original execution
- you intentionally want a new session history rather than continuing the old one
- `resume` exits with code `3`

For the lock and drift rules behind exit code `3`, read [`unsafe-resume.md`](unsafe-resume.md).
