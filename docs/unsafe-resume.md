<!-- @format -->

# Unsafe resume and exit code 3

`runmark` does not treat resume as "just rerun the rest." It only resumes when the saved session still matches the tracked definitions and no other process is already working on that session.

That is why `resume` can exit with code `3`.

## What exit code 3 means

Exit code `3` is reserved for resume safety problems:

- the session is not in a resumable state
- tracked definitions drifted since the original run
- another process still owns the session lock

This is intentional. `runmark` prefers blocking an unsafe continuation over silently running a workflow against changed inputs.

## Common cases

| Situation | What `runmark` does | Recommended next step |
| --- | --- | --- |
| session is `paused` or `failed` and nothing drifted | allows resume | inspect artifacts, then resume |
| session is already `completed`, `running`, `created`, or `interrupted` | returns a non-resumable error | start a fresh run if you need new work |
| tracked request, run, env, or block files changed | returns drift diagnostics and exits `3` | inspect the diff, then start a fresh run |
| another process still holds the lock | exits `3` | wait for the other executor to finish, then retry |

## How to inspect before deciding

Start with:

```bash
runmark session show <sessionId>
runmark artifacts list <sessionId>
```

These tell you:

- the current session state
- the next step that would run
- the persisted outputs already produced
- the artifact paths you can inspect
- any drift diagnostics that block resume

## When to start a fresh run

Start fresh when:

- the tracked workflow changed
- the env wiring changed in a meaningful way
- you want a clean session history for a new investigation
- a previous failure came from stale assumptions rather than a transient dependency issue

## What still remains useful when resume is blocked

Even when `resume` is unsafe, the prior runtime evidence is still valuable:

- `runmark/artifacts/history/<sessionId>/manifest.json`
- `runmark/artifacts/history/<sessionId>/events.jsonl`
- captured request and body artifacts
- `runmark audit export`

Those files help explain what happened without requiring you to continue the original session.
