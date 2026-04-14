<!-- @format -->

# Error codes

`runmark` uses two layers of error signaling:

1. small process exit codes for automation
2. structured diagnostic or error codes inside JSON payloads

## Process exit codes

| Exit code | Meaning | Typical cause |
| --- | --- | --- |
| `0` | success | validation, run, resume, or cleanup completed successfully |
| `1` | execution failure | request assertions failed or runtime execution failed |
| `2` | validation/configuration failure | bad YAML, missing flag values, unsafe paths, missing definitions |
| `3` | unsafe resume | tracked definition drift or session lock conflict |
| `4` | internal error | unexpected tool failure |

## Diagnostic shape

Diagnostics and enriched errors use a consistent public shape:

```json
{
  "level": "error",
  "code": "EXPECTATION_FAILED",
  "message": "status equals: expected 200, got 503",
  "hint": "Update the expect block if the contract changed, or investigate why the response no longer matches.",
  "file": "runmark/requests/recovery/fetch-report.request.yaml",
  "line": 7,
  "column": 3,
  "path": "expect.status"
}
```

## Common user-facing codes

These are the codes most users need to recognize in practice.

| Code | Typical exit code | Meaning |
| --- | --- | --- |
| `EXPECTATION_FAILED` | `1` | a request ran, but an assertion such as status, header, or body expectation failed |
| `EXTRACTION_FAILED` | `1` | a required extraction could not be produced from the response |
| `FLAG_VALUE_REQUIRED` | `2` | a CLI flag that needs a value was passed without one |
| `PROJECT_PATH_INVALID` | `2` | the resolved project root or tracked file path is invalid |
| `RUN_NOT_FOUND` | `2` | the requested run ID does not exist |
| `SESSION_NOT_FOUND` | `2` | the requested session ID does not exist |
| `ARTIFACT_NOT_FOUND` | `2` | the requested artifact path does not exist for that session |
| `BODY_FILE_PATH_INVALID` | `2` | a tracked request body file path is invalid or unsafe |
| `REQUEST_TIMEOUT_INVALID` | `2` | a timeout value is invalid |
| `RUNTIME_PATH_INVALID` | `2` | a runtime path escaped the project root, used a symlink, or had the wrong file type |
| `OUTPUT_PATH_INVALID` | `2` | an audit-export output path escaped the project root or used an unsafe symlinked path |
| `SESSION_SECRET_STATE_INVALID` | `2` | the local secret companion file is missing, mismatched, or out of sync |
| `SESSION_NOT_RESUMABLE` | `3` | the session state is not eligible for resume |
| `SESSION_DRIFT_DETECTED` | `3` | tracked definitions changed since the original run, so resume is blocked |

## How to react

| If you see... | Do this next |
| --- | --- |
| exit code `1` plus `EXPECTATION_FAILED` | inspect the session and artifact history, then decide whether the contract changed or the service regressed |
| exit code `2` plus a path or flag code | fix the command flags, YAML, or local filesystem wiring before retrying |
| exit code `3` | inspect drift or lock state, then retry or start a fresh run |

Related guides:

- [`inspect-and-resume.md`](inspect-and-resume.md)
- [`unsafe-resume.md`](unsafe-resume.md)
- [`filesystem-safety.md`](filesystem-safety.md)
