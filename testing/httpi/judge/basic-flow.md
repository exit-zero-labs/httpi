# basic-flow judge

The implementation passes this flow when:

1. `validate` reports no definition errors for `fixtures/basic-project`.
2. `describe --run smoke` shows the expected step graph, including the parallel fetch block and the explicit pause step.
3. `explain variables --request ping` shows effective values and provenance without exposing secret values.
4. Running `smoke` pauses at `inspect-after-fetch` and writes session plus artifact files under `.httpi/`.
5. `session show <sessionId>` reports the paused state, the next step, and redacted secret or explicitly secret-marked extracted values.
6. `artifacts list <sessionId>` returns the captured paths, and request summary artifacts redact the `authorization` header value.
7. Response-body artifacts redact extracted secret-looking or explicitly secret-marked values such as the login token.
8. Resuming that session completes `touch-user` without re-reading changed tracked definitions.
9. MCP exposes the documented core tools and can successfully validate, describe, explain, and run the same fixture project.
