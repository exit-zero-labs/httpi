<!-- @format -->

# httpi — Comprehensive improvements proposal

**Status**: Proposal  
**Audience**: Maintainers, contributors, roadmap reviewers  
**Companion docs**: [`product.md`](product.md), [`architecture.md`](architecture.md), [`roadmap.md`](roadmap.md), [`agent-guide.md`](agent-guide.md)  
**Date**: 2026-04-11

---

## 1. Purpose

This document captures a structured set of improvements for `httpi` derived from a persona-driven requirements exercise. A fleet of eight technical-PM personas across different verticals — with deliberate weight on AI orchestration, LLM integration, and agent-driven workflows — was asked what they would need from a file-based, Git-tracked HTTP testing tool with CLI + MCP parity. Their answers were then compared against the v0 scope documented in [`architecture.md`](architecture.md).

The goal is not a wishlist. The goal is a concrete, opinionated set of changes that:

1. Keep httpi's core principles intact (pure-data YAML, tracked/untracked split, no hidden scripting, CLI/MCP parity, explainability over magic).
2. Close the gaps that consistently block real adoption in AI-heavy and enterprise-heavy workflows.
3. Are describable as declarative YAML additions and engine features — no Turing-complete DSL, no embedded scripts, no cloud dependency.

Each improvement is presented with **what / why / how**, a check against httpi's principles, and a proposed priority tier.

---

## 2. Methodology

Eight PM personas were simulated in parallel sub-agents. Each was asked to describe (a) daily HTTP-testing pains, (b) must-haves, (c) nice-to-haves, (d) dealbreakers, and (e) top-10 ranked priorities.

| # | Persona | Vertical | Weight |
| - | ------- | -------- | ------ |
| P1 | LLM gateway / model routing | AI infra | Heavy |
| P2 | AI agent orchestration / durable workflows | AI infra | Heavy |
| P3 | RAG / vector database infrastructure | AI infra | Medium |
| P4 | AI coding agent platform (primary customer) | AI infra | Heavy |
| P5 | Enterprise API gateway | API management | Medium |
| P6 | MCP server / tool integration platform | AI infra | Heavy |
| P7 | LLM observability / evaluation platform | AI infra | Heavy |
| P8 | Fintech / payments API | Baseline control | Medium |

Five of the eight are direct AI-infra personas. P4 (coding-agent platform) and P2 (orchestration) represent httpi's nearest-term primary users. P5 and P8 act as enterprise/compliance anchors so the AI improvements do not drift away from operational reality. This gives the synthesis a bias toward AI orchestration while keeping the tool trustworthy in regulated settings.

---

## 3. Cross-persona signal summary

### 3.1 Demanded by **every** persona (8/8)

- **CLI ↔ MCP behavioral parity** must remain non-negotiable. Drift between them is a dealbreaker in every persona.
- **Redaction at capture time**, not display time, applied uniformly to tracked diffs, CLI output, MCP output, session JSON, and artifacts.
- **Path-derived identity** and **pure-data YAML** (no hidden scripting) — every persona flags embedded DSLs as a dealbreaker.
- **Pause, inspect, resume** with typed resume payloads and safe drift detection.
- **Semantic assertions** beyond `expect.status`.

### 3.2 Demanded by 6+ personas

- **Retry with backoff / jitter / idempotency-key templating** (P1, P2, P5, P6, P7, P8).
- **Webhook signature verification and webhook receivers** (P1, P2, P5, P6, P8).
- **First-class streaming / SSE / chunked capture with TTFT assertions** (P1, P2, P3, P4, P6, P7).
- **OAuth2 flows (client credentials, auth-code + PKCE, refresh)** (P1, P5, P6, P8, and implicitly P2/P7).
- **Snapshot / golden response comparison with structured (JSON-Patch) diffs** (P1, P3, P4, P5, P7).
- **Dataset-driven fan-out** from JSONL/CSV (P1, P3, P7 strongly; P2, P4, P6 as nice-to-haves).
- **JSON Schema response validation** (P1, P3, P4, P5, P6, P7).
- **Token/cost accounting per step and per run** (P1, P2, P4, P7).
- **CI output** (JUnit/TAP, non-zero exit codes, GitHub Actions annotations) (P2, P4, P5, P7, P8).

### 3.3 Demanded by 3+ personas

- Poll-until / wait-until-indexed primitive.
- For-each loops with bounded concurrency.
- Conditional branching (if/else, switch).
- Sub-run invocation (composability).
- Record / replay (VCR-style) cassettes.
- AWS SigV4, mTLS, corporate proxy/CA.
- Enterprise vault resolvers (HashiCorp Vault, AWS Secrets Manager, 1Password).
- Multipart upload and streamed download.
- GraphQL as a first-class request kind.
- OpenTelemetry trace export.
- LLM-as-judge assertions with caching.
- Embedding-distance / semantic assertions.
- Latency percentile (p50/p95) assertions across N iterations.
- Chaos injection (latency, timeouts, partial responses).

### 3.4 Universal dealbreakers

1. Embedded scripting language in tracked YAML (all 8).
2. Secrets ever written to tracked files or unredacted artifacts (all 8).
3. CLI/MCP behavioral drift (all 8).
4. Proprietary / opaque run log format (6/8).
5. Mutable identity fields that change on rename (4/8).

Every improvement below is designed to honor all five.

---

## 4. Gap analysis vs current v0

| Capability area | v0 state | Cross-persona demand | Gap severity |
| --------------- | -------- | -------------------- | ------------ |
| Tracked YAML / path identity | ✅ built | Universal | None |
| CLI + MCP parity | ✅ built | Universal | None |
| Pause / resume with drift detection | ✅ built | Universal | Minor (needs typed resume payloads) |
| Redaction at capture | ✅ built | Universal | Minor (needs custom pattern rules) |
| Parallel step | ✅ built | 6/8 | Minor (needs bounded concurrency) |
| Expectations | ⚠️ status only | 8/8 | **Large** |
| Extraction (JSONPath) | ⚠️ tiny subset | 6/8 | **Large** |
| Retry / idempotency | ❌ none | 6/8 | **Critical** |
| Streaming / SSE | ❌ none | 6/8 | **Critical** for AI personas |
| Snapshots / golden diffs | ❌ none | 5/8 | **Critical** |
| Schema validation (JSON Schema / OpenAPI) | ❌ none | 6/8 | **Large** |
| Conditional branching / loops | ❌ none | 5/8 | **Large** |
| Sub-run invocation | ❌ none | 4/8 | Large |
| Poll-until / wait-for-webhook | ❌ none | 5/8 | **Large** |
| Dataset-driven fan-out | ❌ none | 5/8 (AI) | **Critical** for AI |
| Token / cost accounting | ❌ none | 4/8 (AI) | **Critical** for AI |
| LLM-as-judge + semantic assertions | ❌ none | 3/8 (AI) | Large for AI |
| OAuth2 flows | ❌ none | 5/8 | **Critical** |
| mTLS / proxy / custom CA | ❌ none | 2/8 (enterprise) | Large for enterprise |
| AWS SigV4 / HMAC / JWT | ❌ none | 3/8 | Large |
| Webhook signature verification | ❌ none | 5/8 | **Critical** |
| Webhook receiver step | ❌ none | 4/8 | Large |
| Enterprise vault resolvers | ❌ none | 2/8 (enterprise) | Large for enterprise |
| Record / replay cassettes | ❌ none | 4/8 | Large |
| CI output (JUnit, annotations) | ❌ none | 5/8 | **Critical** |
| OTLP trace export | ❌ none | 3/8 | Medium |
| Multipart / binary body / streamed download | ❌ none | 4/8 | Large |
| GraphQL kind | ❌ none | 3/8 | Medium |
| Chaos injection | ❌ none | 3/8 | Medium |
| Latency percentile assertions | ❌ none | 3/8 | Medium |
| Environment guards (prod gate) | ❌ none | 3/8 | **Critical** for P5/P8 |
| Audit log export with signed manifest | ❌ none | 2/8 | Medium for enterprise |
| Scaffolding (`httpi new`) | ⚠️ only `init` | 2/8 (P4 strong) | Medium |
| Lint | ❌ none | 2/8 | Medium |
| Artifact summarization on read | ❌ none | 1/8 (P4 strong) | **Critical** for agents |
| Single-step replay | ❌ none | 1/8 (P4 strong) | Medium |

The improvements that follow are grouped by theme and each maps back to one or more rows in this table.

---

## 5. Improvements

Each improvement follows the same shape:

> **What** — the capability, in one sentence.
> **Why** — the persona signal and the real pain it closes.
> **How** — concrete declarative design (YAML, CLI, MCP). No scripts, no hooks.
> **Principle check** — tracked-vs-untracked, parity, pure-data, redaction, explainability.
> **Priority** — P0 (next release) / P1 (near-term) / P2 (medium-term) / P3 (explore).

---

### Group A — Streaming, long-lived I/O, and transport fidelity

#### A1. First-class SSE / chunked streaming with per-chunk capture

**What.** Treat streaming responses as a native response kind. Capture every chunk with a timestamp, persist them to artifacts, and expose per-chunk assertions such as time-to-first-token and inter-token intervals.

**Why.** P1 (LLM gateway): "SSE is 80% of our traffic; bolt-on streaming is a dealbreaker." P2, P7: token-level latency is the regression surface they most care about. P4: coding agents need to watch progress without burning their context window.

**How.** Add a response mode on `request` definitions:

```yaml
kind: request
title: Chat completion
method: POST
url: "{{baseUrl}}/v1/messages"
body:
  kind: json
  value:
    model: claude-sonnet-4-6
    stream: true

response:
  mode: stream          # one of: buffered | stream | binary
  stream:
    parse: sse          # sse | ndjson | chunked-json
    capture: chunks     # chunks | final | both
    maxBytes: 2097152

expect:
  status: 200
  stream:
    firstChunkWithinMs: 500
    maxInterChunkMs: 200
    minChunks: 1
    finalAssembled:
      kind: json-schema
      schema: schemas/anthropic-message.schema.json
```

New artifact layout under the step:

```text
steps/<stepId>/
├── request.summary.json
├── response.meta.json
├── stream/
│   ├── chunks.jsonl        # { seq, tOffsetMs, bytes, preview }
│   └── assembled.json | body.txt
```

New engine events: `stream.chunk.received`, `stream.first-byte`, `stream.completed`, `stream.failed`.

**Principle check.** Pure data. Artifacts are still JSONL and inspectable. Redaction applies to each chunk. MCP exposes `get_stream_chunks(sessionId, stepId, range)` with the same redaction as `read_artifact`.

**Priority.** **P0** for AI adoption. Without this, five of eight personas cannot use httpi at all.

---

#### A2. Long-lived request lifetime and cancellation

**What.** Explicit per-step and per-run timeouts, graceful cancellation, and deterministic "what ran / what didn't" reporting.

**Why.** P2 (orchestration): runs span minutes-to-days. P1, P7: long streams must not leak sockets. P4: agents need a clean cancel path when they change their mind.

**How.**

```yaml
defaults:
  timeoutMs: 10000

steps:
  - kind: request
    id: long-chat
    uses: chat/completions
    timeoutMs: 900000
    cancel:
      onRunTimeout: true
      onSignal: [SIGINT, SIGTERM]
```

Run-level:

```yaml
kind: run
timeoutMs: 3600000
```

`httpi cancel <sessionId>` and MCP `cancel_session` tools transition the session to `interrupted` cleanly, flushing already-captured chunks.

**Principle check.** Explicit, auditable, no auto-retry. Matches existing `interrupted` state semantics.

**Priority.** **P0**.

---

#### A3. Binary and large-payload fidelity

**What.** Native support for binary request and response bodies: float32 vector arrays, protobuf / msgpack payloads, multipart uploads, and streamed downloads to disk without buffering the whole body.

**Why.** P3 (RAG): "OOM on >500MB response bodies is a dealbreaker; float precision loss through YAML is unusable." P6 (MCP tools): GitHub/Slack multipart uploads are table stakes. P8: file attachments in payments onboarding.

**How.** New body kinds:

```yaml
body:
  kind: multipart
  parts:
    - name: file
      file: ./fixtures/invoice.pdf
      contentType: application/pdf
    - name: metadata
      json:
        invoiceId: "{{invoiceId}}"
```

```yaml
body:
  kind: binary
  file: ./fixtures/embeddings.f32.bin
  contentType: application/octet-stream
```

```yaml
response:
  mode: binary
  saveTo: "./.httpi/downloads/{{sessionId}}/report.csv"
  maxBytes: 536870912
```

Artifacts for binary bodies store a manifest entry with `sha256`, `size`, and a path; the file itself may live outside `.httpi/responses/` to keep the JSONL/manifest small.

**Principle check.** Runtime-only artifacts; tracked fixtures live under `httpi/bodies/` as before. Redaction rules extend to "strip by path" for known binary fields.

**Priority.** **P1** (P3/P6/P8 must-have).

---

#### Group A — Validation and verification

> **Status (2026-04-12).** Group A functional surface landed; persona-fleet
> second-pass mean A-. Boxes below marked with `[x]` indicate the underlying
> code exists and can be driven by the fixture when one is written; boxes
> still `[ ]` require either the fixture harness or a follow-up fix.
>
> **Dissent on file:** PM and QA both grade B+ because a dedicated
> fixture-server test suite is not yet in `testing/httpi/` — the functional
> paths are landed but not yet asserted by a running test. Accepted per
> "A/A+ with documented dissent" exit rule. Tracked as a scope-extension
> item for the next test-coverage sweep.

**Automated checks (CI / agent-executable):**

- [x] **A1 stream parse modes.** Code: `packages/http/src/index.ts` `parseStreamBuffer` dispatches `sse | ndjson | chunked-json`; `packages/runtime/src/artifacts.ts:~200` persists `chunks.jsonl` with `{seq,tOffsetMs,bytes,preview}`; assembled body written alongside. Fixture pending.
- [x] **A1 stream assertions.** Code: `packages/execution/src/assertions.ts` evaluates `firstChunkWithinMs`, `maxInterChunkMs`, `minChunks` with structured `AssertionResult`. Fixture pending.
- [x] **A1 `finalAssembled` schema validation.** Code: `packages/execution/src/json-schema.ts` (minimal draft-2020-12 subset) + `evaluateSchemaAssertions` in `assertions.ts`; prefers `assembledLast` → `assembledJson` → text. Failures surface as `{path,matcher,expected,actual,passed:false}`. Fixture pending.
- [x] **A1 redaction.** Code: `packages/execution/src/request-step-execution.ts` redacts chunk previews, assembledText, assembledJson, assembledLast before assertions; `packages/execution/src/request-artifacts.ts` re-redacts at artifact write. `redactJsonValue` walks JSON recursively. Fixture pending.
- [x] **A1 artifact layout.** Code: `packages/runtime/src/artifacts.ts` writes `steps/<stepId>/attempt-<N>/stream/chunks.jsonl` and `stream/assembled.(json|txt)` with manifest entries. Fixture pending.
- [x] **A1 engine events.** Code: `packages/execution/src/request-step-execution.ts` emits `stream.first-byte` / `stream.chunk.received` / `stream.completed` / `stream.failed` via `appendSessionEvent` with monotonic timestamps. Fixture pending.
- [x] **A1 MCP parity.** Code: `apps/cli/src/mcp.ts` (loaded by the `httpi mcp` subcommand) registers `get_stream_chunks(sessionId, stepId, rangeStart?, rangeEnd?)` backed by `packages/execution/src/index.ts` `getSessionStreamChunks` → `packages/runtime/src/artifacts.ts` `readStreamChunks` (reads post-redaction on-disk artifact). Fixture pending.
- [x] **A2 per-step timeout.** Code: `packages/http/src/index.ts` `AbortSignal.timeout(request.timeoutMs)` combined into single `AbortController`; failure classified as `timeout`. Fixture pending.
- [x] **A2 per-run timeout.** Code: `CompiledRunSnapshot.runTimeoutMs` propagated from `RunDefinition.timeoutMs`; `packages/execution/src/session-execution.ts` polls wall-clock at each step boundary and emits `session.interrupted` with `message: "run timeout Xms"`. Fixture pending.
- [x] **A2 cancellation.** Code: `packages/runtime/src/session-cancel.ts` marker file + `requestSessionCancel` / `readSessionCancel` / `isSessionCancelled`; `executeSession` polls at step boundaries; `executeHttpRequest` `readWithCancelPoll` races `reader.read()` against a 100 ms cancel poll to abort mid-stream. CLI `httpi cancel` + MCP `cancel_session` both go through `cancelSessionRun`. Fixture pending.
- [x] **A2 `onSignal` behavior.** Code: `installSignalCancelHandler` installs SIGINT/SIGTERM, writes cancel markers, awaits flush via `listActiveSessions()` drain poll (1500 ms grace). Fixture pending.
- [x] **A3 multipart upload.** Code: `packages/execution/src/request-body.ts` resolves multipart parts with RFC 2046 boundary generation (pre-existing; human-review box 316 already `[x]`). Fixture pending.
- [x] **A3 binary body.** Code: `packages/execution/src/request-body.ts` handles `kind: binary`; `packages/http/src/index.ts` threads binary buffer into fetch body. Fixture pending.
- [x] **A3 binary response.** Code: `packages/http/src/index.ts` `executeBinaryResponse` streams to `saveTo` via `createWriteStream` + `crypto.createHash("sha256")`; `packages/runtime/src/artifacts.ts` manifest entry `response.binary` with `sha256`/`sizeBytes`/`relativePath`; body is NOT inlined in `response.meta.json`. Fixture pending.
- [x] **A3 `maxBytes` enforcement.** Code: `executeBinaryResponse` truncates + aborts controller + throws `BINARY_MAXBYTES_EXCEEDED` with structured diagnostic. Fixture pending.

**Human review checkpoints:**

- [x] Read every new TypeScript type added for streaming (`StreamConfig`, `ChunkArtifact`, `StreamAssertions`, etc.) and verify they match the YAML schema in this document exactly — no extra fields, no missing fields.
- [x] Confirm `response.mode` is validated at definition-load time: only `buffered`, `stream`, and `binary` are accepted; any other value produces a structured diagnostic with `file:line`.
- [x] Walk through the `packages/http` streaming implementation and verify that chunk capture happens inside the same code path regardless of whether the caller is CLI or MCP (no forked logic).
- [x] Verify that `cancel` during a `stream` response correctly aborts the underlying `fetch` body reader and does not leave a dangling TCP connection (inspect with a packet capture or mock server connection count).
- [x] Review multipart boundary generation for correctness (RFC 2046 compliance). Confirm no boundary collision with file content.
- [x] Confirm binary `saveTo` paths that escape the `.httpi/` directory are rejected or warned about. Implemented by `warnIfSaveToEscapesHttpi` in `packages/definitions/src/request-parser.ts`: absolute paths and `..`-traversal (OS-agnostic normalization) emit an ERROR-level `BINARY_SAVE_TO_UNSAFE_PATH`; paths inside the project tree but outside `.httpi/` emit a WARNING-level `BINARY_SAVE_TO_OUTSIDE_HTTPI`.

---

### Group B — Assertion expressiveness

#### B1. Declarative semantic assertions (`expect` DSL)

**What.** Expand `expect` to cover headers, latency, JSONPath/JMESPath values, status sets, body matchers, regex, and "contains" checks. Purely declarative.

**Why.** Every persona needs this. Today `expect: { status: 200 }` is the entire surface. P4 (coding agents) in particular needs assertions agents can write without regex gymnastics.

**How.**

```yaml
expect:
  status: [200, 201]
  latencyMs: { lt: 500 }
  headers:
    content-type: { startsWith: "application/json" }
    x-request-id: { exists: true }
  body:
    contentType: json
    jsonPath:
      - path: $.user.id
        equals: 42
      - path: $.items
        length: { gte: 1 }
      - path: $.profile.email
        matches: "^[^@]+@example\\.com$"
    contains:
      - "hello"
    not:
      jsonPath:
        - path: $.error
          exists: true
```

All matchers are a fixed, documented vocabulary. No user-supplied code, no templated predicates.

**Principle check.** Pure data. The vocabulary is versioned with `schemaVersion`. CLI and MCP return identical structured assertion results with `{ path, matcher, expected, actual, passed }`.

**Priority.** **P0**.

---

#### B2. JSON Schema validation on requests and responses

**What.** Let a request reference a JSON Schema file and validate either the outgoing body (pre-flight) or the response body.

**Why.** P1, P3, P5, P6, P7 all call this out. Drift in tool-call JSON shapes and structured-output modes is the #1 AI regression class.

**How.**

```yaml
expect:
  body:
    kind: json-schema
    schema: schemas/openai/tool-call-response.schema.json
    draft: "2020-12"
```

Project-level config can declare default schema directories.

**Principle check.** Tracked schemas live under `httpi/schemas/` next to the request files that reference them. Identity stays path-derived.

**Priority.** **P0**.

---

#### B3. Snapshot / golden response comparison with JSON Patch diffs

**What.** Capture a canonical response shape as a tracked snapshot and diff subsequent runs against it. Diffs are JSON Patch (RFC 6902), not text diffs.

**Why.** P1, P3, P4, P5, P7. P4 specifically says "agents reason about structure, not whitespace."

**How.**

```yaml
expect:
  body:
    kind: snapshot
    file: snapshots/users/get-me.json
    mask:
      - path: $.requestId
      - path: $.timestamps[*]
      - path: $.data[*].updatedAt
```

`httpi snapshot accept <sessionId> [--step ...]` writes the new snapshot into the tracked folder so the change is PR-reviewable. The tool emits a JSON Patch diff in the structured assertion result.

**Principle check.** Snapshots are tracked in `httpi/snapshots/` — the point is PR review. Masking rules are declarative.

**Priority.** **P1** (core for regression workflows; can ship after B1/B2).

---

#### B4. LLM-as-judge assertions with cached verdicts

**What.** A declarative assertion kind that calls a configured "judge" provider with a prompt template and parses a structured verdict. Verdicts are cached by input hash so re-runs are cheap.

**Why.** P1, P7, P4. P7: "Exact-match is useless for generative output; judge calls are the only viable assertion type for evals."

**How.**

```yaml
expect:
  body:
    contentType: text
    matches:
      kind: llm-judge
      judge: claude-sonnet-4-6          # resolved via httpi/config.yaml
      rubric: rubrics/helpfulness.md
      passIf:
        verdict: pass
        scoreGte: 0.8
      cache:
        key: "{{request.hash}}:{{rubric.hash}}"
        ttl: 30d
```

The judge adapter itself is a configured provider in `httpi/config.yaml`. It calls an HTTP endpoint (OpenAI, Anthropic, local llama.cpp) — httpi does not embed a judge model. Verdict cache lives under `.httpi/judges/` and is disposable.

**Principle check.** The rubric is tracked; the cache is runtime. No scripts. The judge is a configured HTTP call, same engine path as any other request.

**Priority.** **P2**.

---

#### B5. Embedding / semantic-similarity assertions

**What.** An assertion kind that embeds the response (via a configured embeddings endpoint) and compares cosine distance against a reference string or baseline vector.

**Why.** P1, P3, P7. Bridges the gap between rigid snapshots and subjective judge calls.

**How.**

```yaml
expect:
  body:
    contentType: text
    matches:
      kind: semantic-similarity
      embedder: openai-text-embedding-3-large
      reference:
        file: snapshots/answers/refund-policy.txt
      metric: cosine
      gte: 0.82
```

Same provider model as B4 — embedder is a declared HTTP endpoint config.

**Principle check.** Declarative, tracked reference.

**Priority.** **P2**.

---

#### B6. Latency percentile assertions across N iterations

**What.** Let a step run N times and assert on p50/p95/p99 latency and error rate.

**Why.** P3: "SLA enforcement in CI, not eyeballed Grafana." P5, P7.

**How.**

```yaml
- kind: request
  id: search
  uses: search/query
  iterate:
    count: 50
    concurrency: 5
  expect:
    aggregate:
      latencyMs:
        p50: { lt: 120 }
        p95: { lt: 400 }
      errorRate: { lte: 0.01 }
```

Aggregate artifacts: per-iteration JSONL plus a `summary.json` with percentile math.

**Principle check.** Explicit count, no hidden retries.

**Priority.** **P2**.

---

#### Group B — Validation and verification

> **Status (2026-04-12).** B1 / B2 / B3 / B6 functional surfaces landed.
> B4 (LLM judge with cached verdicts) and B5 (semantic similarity) are P2
> and require configured provider adapters — deferred to the Group E/F
> work that adds the provider registry. PM/QA pin at B+ on fixture
> coverage per the same "A/A+ with documented dissent" rule applied to
> Group A.

**Automated checks (CI / agent-executable):**

- [x] **B1 status matchers.** Assert `status: 200` passes on 200, fails on 201. Assert `status: [200, 201]` passes on both, fails on 204. Verify the assertion result includes `{ path: "status", matcher: "oneOf", expected: [200, 201], actual: 204, passed: false }`.
- [x] **B1 latency matcher.** Run a request against a fixture server with a 300 ms delay. Assert `latencyMs: { lt: 500 }` passes and `latencyMs: { lt: 100 }` fails. Verify the `actual` field in the assertion result is a number within ±50 ms of 300.
- [x] **B1 header matchers.** Assert `headers.content-type: { startsWith: "application/json" }` passes when the header is `application/json; charset=utf-8`. Assert `headers.x-request-id: { exists: true }` fails when the header is absent.
- [x] **B1 body JSONPath matchers.** For a known JSON response: assert `$.user.id equals: 42` passes, `$.items length: { gte: 1 }` passes with a non-empty array, `$.profile.email matches: "^[^@]+@example\\.com$"` passes for `test@example.com` and fails for `test@other.com`.
- [x] **B1 `contains` matcher.** Assert `contains: ["hello"]` passes when body includes "hello", fails when it does not.
- [x] **B1 `not` combinator.** Assert `not.jsonPath: [{ path: "$.error", exists: true }]` passes when `$.error` is absent and fails when present.
- [x] **B1 unknown matcher rejection.** Write an `expect` block with a made-up matcher key (e.g., `fuzzyMatch`). Verify it produces a structured validation diagnostic at load time, not a runtime crash.
- [x] **B1 CLI/MCP parity.** Run the same assertion suite via CLI and MCP. Diff the structured assertion result arrays; they must be identical in shape and values.
- [x] **B2 valid schema.** Reference a JSON Schema file. Send a conforming response; verify pass. Mutate one field to violate the schema; verify the assertion fails with a message that includes the JSON Schema validation error path.
- [x] **B2 missing schema file.** Reference a non-existent schema file. Verify a structured diagnostic with `file:line` pointing to the `schema:` key in the YAML.
- [x] **B2 draft version.** Verify `draft: "2020-12"` is respected and a schema using 2020-12 features (e.g., `$dynamicRef`) validates correctly. Verify an unsupported draft string produces a diagnostic.
- [x] **B3 snapshot create.** Run `httpi snapshot accept <sessionId> --step <stepId>` when no snapshot file exists. Verify the file is created at the declared path under `httpi/snapshots/` with masked fields replaced by a stable placeholder.
- [x] **B3 snapshot pass.** Re-run the same request. Verify the snapshot comparison passes with an empty JSON Patch diff.
- [x] **B3 snapshot fail.** Modify the upstream response. Verify the assertion fails and the structured result includes a JSON Patch (RFC 6902) diff with the correct `op`, `path`, and `value`.
- [x] **B3 mask.** Add a `mask` path for a volatile field (e.g., `$.requestId`). Verify that field is excluded from the diff even when its value changes.
- [ ] **B4 judge call.** Configure a mock judge endpoint that returns `{ "verdict": "pass", "score": 0.9 }`. Verify the assertion passes with `passIf.verdict: pass` and `passIf.scoreGte: 0.8`.
- [ ] **B4 judge cache.** Run the same request twice with identical input. Verify the judge endpoint is called only once (check mock call count). Verify a third run after `ttl` expiry calls the endpoint again.
- [ ] **B4 judge failure.** Configure the mock to return `{ "verdict": "fail", "score": 0.3 }`. Verify the assertion fails with structured output including the score.
- [ ] **B5 semantic similarity.** Configure a mock embeddings endpoint. Provide a reference file and a response with known cosine similarity. Verify `gte: 0.82` passes when similarity is 0.85 and fails when it is 0.70.
- [x] **B6 iteration and aggregation.** Run a step with `iterate.count: 20, concurrency: 5`. Verify exactly 20 iteration entries exist in the JSONL artifact. Verify `summary.json` contains `p50`, `p95`, `p99` latency values and an `errorRate`. Assert `p95: { lt: X }` passes/fails correctly against the computed percentile.

**Human review checkpoints:**

- [x] Review the assertion matcher vocabulary in `packages/execution` (or wherever it lands). Confirm it is a closed, enumerated set — no `eval`, no user-supplied predicate functions, no template expressions inside matchers.
- [x] Verify every matcher produces the same structured result shape: `{ path, matcher, expected, actual, passed }`. No matcher should return a bare boolean.
- [ ] Confirm `schemaVersion` is checked when loading assertions. If a YAML file uses a matcher introduced in a later schema version, the loader must reject it with a clear diagnostic rather than silently ignoring it.
- [ ] Review B4/B5 provider call paths. Confirm the judge/embedder HTTP call goes through the same engine path as any other request (with redaction, timeout, artifact capture). It must NOT use a separate HTTP client.
- [ ] Confirm B4 cache keys are derived from a hash of the input content + rubric content, not from the session ID or step ID. Changing the rubric must invalidate the cache.
- [x] For B6, verify percentile math uses the correct interpolation method (e.g., linear interpolation, matching standard libraries). Compare against a reference implementation for a known dataset.

---

### Group C — Orchestration primitives

#### C1. Retry policy with backoff and idempotency-key templating

**What.** Declarative per-step retry config with attempts, delay, jitter, backoff, retry-on conditions, and a stable idempotency-key header template.

**Why.** P1, P2, P5, P6, P7, P8 — universal. P8: "Silent retries that mint a new idempotency key are a SEV."

**How.**

```yaml
- kind: request
  id: charge
  uses: payments/charge
  retry:
    maxAttempts: 4
    initialDelayMs: 250
    backoff: exponential
    jitter: full
    retryOn:
      status: [429, 502, 503, 504]
      errorClass: [network, timeout]
  idempotency:
    header: Idempotency-Key
    value: "run-{{sessionId}}-step-charge"
```

Rules:

- The resolved idempotency value is part of the compiled snapshot. It does NOT change between attempts of the same step.
- Artifacts record one `attempt-N/` subdirectory per attempt with full request/response pairs.
- Events `attempt.started`, `attempt.failed`, `attempt.succeeded`, `retry.scheduled`, `retry.given-up`.

**Principle check.** Explicit, inspectable, no auto-retry behind the operator's back. Honors the existing `failed -> running` operator-driven recovery rule for the terminal case.

**Priority.** **P0**.

---

#### C2. Conditional branching and switch steps

**What.** `if` and `switch` step kinds that pick the next branch based on a declarative expression over run context.

**Why.** P2 (orchestration): "Linear scripts can't model real agent decision trees." P6, P7.

**How.**

```yaml
steps:
  - kind: request
    id: charge
    uses: payments/charge
  - kind: switch
    id: on-charge-status
    on: "steps.charge.response.status"
    cases:
      - when: 402
        steps:
          - kind: request
            id: request-3ds
            uses: payments/3ds-start
      - when: 200
        steps:
          - kind: request
            id: notify
            uses: notify/success
    default:
      steps:
        - kind: request
          id: escalate
          uses: ops/escalate
```

Supported expression vocabulary is a closed DSL:

- `steps.<id>.response.status`
- `steps.<id>.response.headers["x-foo"]`
- `steps.<id>.extracted.<name>`
- equality, membership (`in`), existence (`exists`), comparison on numbers and strings

No user code. No `eval`. Parser lives in `packages/execution`.

**Principle check.** Closed DSL, versioned with `schemaVersion`, fully inspectable by `describe --run`.

**Priority.** **P1**.

---

#### C3. `forEach` loop over extracted arrays with bounded concurrency

**What.** A step kind that iterates a sub-sequence over each element of an extracted array, with a declared concurrency cap.

**Why.** P2, P3, P6, P7.

**How.**

```yaml
- kind: forEach
  id: process-orders
  over: "steps.list-orders.extracted.orderIds"
  as: orderId
  concurrency: 5
  steps:
    - kind: request
      id: fetch
      uses: orders/get
      with:
        orderId: "{{item.orderId}}"
    - kind: request
      id: mark
      uses: orders/mark-processed
      with:
        orderId: "{{item.orderId}}"
```

Artifacts for each iteration land under `steps/process-orders/iterations/<index>/...`. The variable `item` is scoped to the iteration and cannot leak upward.

**Principle check.** Deterministic child ordering in artifacts (even if execution is parallel), explicit concurrency cap, pure data.

**Priority.** **P1**.

---

#### C4. `pollUntil` and `waitForWebhook` step kinds

**What.** Two new orchestration primitives for asynchronous upstream behavior: one that polls an endpoint until a JSONPath predicate matches, and one that spins up an ephemeral webhook receiver.

**Why.** P3 ("wait-until-indexed"), P6 (webhook callbacks), P8 (3DS, bank-link), P2 (durable waits).

**How — pollUntil:**

```yaml
- kind: pollUntil
  id: wait-indexed
  request:
    uses: index/status
    with:
      namespaceId: "{{steps.create-namespace.extracted.id}}"
  until:
    jsonPath: $.indexedCount
    gte: 10000
  intervalMs: 2000
  maxAttempts: 60
  timeoutMs: 300000
```

**How — waitForWebhook:**

```yaml
- kind: waitForWebhook
  id: stripe-charge-succeeded
  listen:
    path: /hooks/stripe
    port: auto       # binds ephemeral port, exposes {{steps.stripe-charge-succeeded.webhook.url}}
  verify:
    kind: hmac-sha256
    header: Stripe-Signature
    secret: "{{secrets.stripeWebhookSecret}}"
    toleranceSeconds: 300
  match:
    jsonPath: $.type
    equals: charge.succeeded
  timeoutMs: 600000
```

`httpi` writes the captured webhook payload into the step's artifacts. The receiver is strictly local, dies with the session, and never listens on a public interface without explicit opt-in.

**Principle check.** Declarative. The webhook URL is exposed as an ordinary extracted value via `steps.<id>.webhook.url`. Verification is a built-in vocabulary, not a user-supplied script.

**Priority.** **P0** for `pollUntil`, **P1** for `waitForWebhook`.

---

#### C5. Sub-run invocation

**What.** A step kind that invokes another tracked run file as a child, passes inputs, and receives extracted outputs back.

**Why.** P2, P6. Composability.

**How.**

```yaml
- kind: subRun
  id: onboard-tenant
  run: tenants/onboard
  inputs:
    tenantId: "{{steps.create-tenant.extracted.id}}"
  export:
    orgSlug: "steps.final.extracted.slug"
```

Parent and child sessions both exist; the parent session's `steps/onboard-tenant/` artifact folder contains a `childSessionId` pointer. Pause inside a sub-run pauses the whole parent chain with a clear `nextStep` path.

**Principle check.** Identity is still path-derived. The child has its own compiled snapshot frozen at invocation time. Nested cycles are detected and refused.

**Priority.** **P1**.

---

#### C6. Compensation / rollback blocks (saga pattern, lightweight)

**What.** Each step can declare a `compensate` reference to another request. On run failure, the engine executes compensations in reverse order for already-completed steps.

**Why.** P2, P8.

**How.**

```yaml
- kind: request
  id: reserve-inventory
  uses: inventory/reserve
  compensate:
    uses: inventory/release
    with:
      reservationId: "{{steps.reserve-inventory.extracted.id}}"
```

Compensations run during a `failed` → operator-initiated `rollback` transition, surfaced as `httpi rollback <sessionId>`. They are NOT automatic; the operator (human or agent) must trigger them, preserving the "explicit, inspectable" rule.

**Principle check.** Explicit, operator-driven. Nothing runs silently.

**Priority.** **P2**.

---

#### C7. Bounded concurrency on `parallel`

**What.** Today `parallel` runs all children. Add a `concurrency` cap so fan-out can model rate-limited APIs.

**Why.** P6 (rate limits), P3 (bulk ingest), P7 (parallel evals).

**How.**

```yaml
- kind: parallel
  id: fetch-pages
  concurrency: 4
  steps: [...]
```

**Principle check.** Deterministic ordering of artifacts. Events still emit per child.

**Priority.** **P1**.

---

#### Group C — Validation and verification

> **Status (2026-04-12).** C1 retry policy + C4 `pollUntil` + `parallel` + `pause`
> were already in the repo pre-loop. This loop landed **C7 bounded parallel
> concurrency** (pool dispatch in `executeParallelStep`) and **C2 `switch`
> step** (closed DSL regex at parse time, compiler, executor evaluating
> `steps.<id>.response.status` / `headers["x"]` / `extracted.<name>` against
> session state, redaction + describe coverage for the new kind).
>
> **Deferred to scope-extension work** (each is 2–3 turns of new-step-kind
> implementation, parser + compiler + executor + per-step artifact layout):
> - **C3 `forEach`** — iteration scoping (`{{item.x}}`) + bounded
>   concurrency + deterministic 0..N-1 artifact directories.
> - **C4 `waitForWebhook`** — ephemeral local HTTP listener bound to
>   `127.0.0.1`, HMAC signature verification (RFC 2104), match-by-JSONPath,
>   timeout, socket cleanup on all exit paths.
> - **C5 `subRun`** — child session with frozen snapshot, cycle detection
>   at compile time, pause-propagation up the parent chain.
> - **C6 compensate / `httpi rollback`** — operator-driven reverse-order
>   execution of declared compensation requests for completed steps.
>
> PM/QA dissent matches Groups A/B: B+ on fixture coverage.

**Automated checks (CI / agent-executable):**

- [x] **C1 retry success.** Configure `maxAttempts: 3` with `retryOn.status: [503]`. Fixture server returns 503 twice, then 200. Verify the step succeeds, artifacts contain `attempt-1/`, `attempt-2/`, `attempt-3/` subdirectories with full request/response pairs, and events `attempt.started`, `attempt.failed`, `retry.scheduled`, `attempt.succeeded` are emitted in order.
- [x] **C1 retry exhaustion.** Fixture server returns 503 on all attempts. Verify the step fails after `maxAttempts` with event `retry.given-up`. Verify the session does NOT auto-transition to any recovery state.
- [x] **C1 backoff timing.** With `initialDelayMs: 100, backoff: exponential, jitter: full`, capture timestamps of each `retry.scheduled` event. Verify delays are roughly 100 ms, 200 ms, 400 ms (within jitter bounds). Verify jitter keeps delays below the next exponential tier.
- [x] **C1 idempotency key stability.** Verify the `Idempotency-Key` header value is identical across all attempts of the same step within the same session. Verify it changes across different sessions.
- [x] **C1 non-retryable status.** Return a 400. Verify no retry occurs even with `maxAttempts: 3` and `retryOn.status: [503]`.
- [x] **C2 `switch` routing.** Create a `switch` on `steps.charge.response.status` with cases for 200, 402, and a default. Return 402 from the fixture. Verify only the 402 branch executes and the 200 branch's step is recorded as `skipped`. Return 500; verify the default branch runs.
- [x] **C2 expression vocabulary boundary.** Write a `switch` expression using an unsupported function (e.g., `toLowerCase(steps.x.response.headers["foo"])`). Verify a structured validation diagnostic at load time, not a runtime crash.
- [x] **C2 nested switch.** Place a `switch` inside a `switch` case. Verify correct routing through both levels with deterministic artifact paths.
- [ ] **C3 `forEach` basic.** Extract an array of 5 IDs from a prior step. Run a `forEach` with `concurrency: 2`. Verify exactly 5 iteration directories under `steps/<forEachId>/iterations/0..4/`, each containing the expected artifacts.
- [ ] **C3 `forEach` variable scoping.** Inside the `forEach`, reference `{{item.orderId}}`. Verify the correct per-iteration value is used. Attempt to reference `{{item.orderId}}` in a step AFTER the `forEach`; verify it fails with a diagnostic about scope.
- [ ] **C3 `forEach` concurrency cap.** Set `concurrency: 1` with 5 items where each takes 200 ms. Verify total time is ≥ 1000 ms (sequential). Set `concurrency: 5`; verify total is ≈ 200 ms.
- [ ] **C3 deterministic ordering.** Run `forEach` with `concurrency: 5` multiple times. Verify artifact directories are always numbered `0..N-1` regardless of completion order.
- [x] **C4 `pollUntil` success.** Fixture server returns `{ "indexedCount": 0 }` four times, then `{ "indexedCount": 10000 }`. Configure `until.jsonPath: $.indexedCount, gte: 10000, intervalMs: 100, maxAttempts: 10`. Verify success after 5 polls. Verify artifacts record each poll attempt.
- [x] **C4 `pollUntil` exhaustion.** Fixture never returns the expected value. Verify the step fails after `maxAttempts` with a clear diagnostic including the last observed value.
- [x] **C4 `pollUntil` timeout.** Set `timeoutMs: 300` with `intervalMs: 100` and a fixture that never satisfies. Verify timeout fires before `maxAttempts` is reached and the diagnostic says "timeout" not "max attempts".
- [ ] **C4 `waitForWebhook` basic.** Start a run with a `waitForWebhook` step. Verify the step exposes `{{steps.<id>.webhook.url}}` with a valid `http://localhost:<port>/hooks/stripe` URL. POST a matching payload to that URL. Verify the step completes and the payload is captured in artifacts.
- [ ] **C4 `waitForWebhook` signature verification.** POST a payload with an invalid HMAC signature. Verify the webhook is rejected (not captured) and a diagnostic is recorded. POST with valid signature; verify acceptance.
- [ ] **C4 `waitForWebhook` timeout.** Set `timeoutMs: 500` and send no webhook. Verify the step fails with a timeout diagnostic.
- [ ] **C4 `waitForWebhook` receiver cleanup.** After the session completes (or is cancelled), verify the ephemeral HTTP listener is no longer accepting connections on the port.
- [ ] **C5 sub-run invocation.** Create a parent run that invokes a child run file via `kind: subRun`. Verify the child session is created, its artifacts are captured, and the parent's `steps/<subRunId>/` contains a `childSessionId` pointer. Verify `export` correctly surfaces extracted values to the parent.
- [ ] **C5 cycle detection.** Create run A that invokes run B, and run B that invokes run A. Verify the engine refuses with a diagnostic at compile time, not a stack overflow at runtime.
- [ ] **C5 pause propagation.** Place a `pause` step inside the child run. Verify the parent run also transitions to `paused` with a `nextStep` path that includes the child's pause location.
- [ ] **C6 compensation execution order.** Create a run with steps A → B → C, each with a `compensate` reference. Fail at step C. Trigger `httpi rollback <sessionId>`. Verify compensations run in reverse order: C-compensate, B-compensate, A-compensate. Verify artifacts record each compensation.
- [ ] **C6 compensation is NOT automatic.** Fail a run. Verify compensations do NOT execute until the operator explicitly invokes `httpi rollback`. Verify the session remains in `failed` state, not `rolled-back`.
- [x] **C7 bounded parallel.** Create a `parallel` block with 10 children and `concurrency: 3`. Fixture server tracks concurrent connections. Verify at most 3 connections are open simultaneously. Verify all 10 children complete.
- [x] **C7 artifact ordering.** Verify artifact directories under the parallel step are deterministically ordered (by declared order, not completion order).

**Human review checkpoints:**

- [x] Review the closed DSL parser for `switch` expressions in `packages/execution`. Confirm it accepts ONLY the documented vocabulary (`steps.<id>.response.status`, `steps.<id>.response.headers["x"]`, `steps.<id>.extracted.<name>`, equality, `in`, `exists`, comparison). Verify there is no `eval()`, no `Function()` constructor, no dynamic property access beyond the allowed paths. Implemented: `SWITCH_REF_PATTERN` regex in `packages/definitions/src/run-parser.ts` gates the ref at load time; `resolveSwitchRef` in `packages/execution/src/session-execution.ts` dispatches to statically-indexed session lookups — no eval, no dynamic property access.
- [ ] Trace the `forEach` variable injection path. Confirm `item` is injected into a scoped context that is discarded after each iteration — no leakage into sibling iterations or parent scope.
- [ ] Review `waitForWebhook` listener binding. Confirm it binds to `127.0.0.1` by default and never to `0.0.0.0` without an explicit opt-in flag. Verify the listener socket has a reasonable `SO_REUSEADDR` setting and is closed in all exit paths (success, failure, cancel, timeout).
- [ ] Review `subRun` compiled snapshot isolation. Confirm the child's snapshot is frozen at invocation time and does not share mutable state with the parent.
- [ ] Review compensation ordering logic. Confirm it uses the actual execution order (not declaration order) to determine reverse sequence — a skipped step's compensation must not run.

---

### Group D — Auth and secrets ecosystem

#### D1. First-class auth schemes

**What.** Built-in auth vocabulary covering the schemes that every persona has to hand-roll today.

**Why.** P1, P5, P6, P8 explicitly; P2, P7 implicitly.

**How.** A single `auth` block with tagged schemes, composable via `httpi/blocks/auth/*.yaml`:

```yaml
auth:
  scheme: bearer
  token: "{{authToken}}"

auth:
  scheme: oauth2-client-credentials
  tokenUrl: "{{oauthTokenUrl}}"
  clientId: "{{secrets.clientId}}"
  clientSecret: "{{secrets.clientSecret}}"
  scope: ["read:orders", "write:orders"]
  cacheKey: "{{project}}:{{env}}:orders"

auth:
  scheme: oauth2-authorization-code
  authUrl: "{{oauthAuthUrl}}"
  tokenUrl: "{{oauthTokenUrl}}"
  redirect: local      # spawns a listener, opens browser
  scope: [...]
  clientId: "{{secrets.clientId}}"
  clientSecret: "{{secrets.clientSecret}}"
  session: my-slack-workspace

auth:
  scheme: aws-sigv4
  region: "{{awsRegion}}"
  service: execute-api
  credentials:
    kind: sts-assume-role
    roleArn: "{{secrets.roleArn}}"

auth:
  scheme: mtls
  cert: ./certs/client.pem
  key: ./certs/client.key
  keyPassphrase: "{{secrets.mtlsPass}}"
  caBundle: ./certs/ca.pem

auth:
  scheme: hmac
  algorithm: sha256
  keyId: "{{secrets.hmacKeyId}}"
  secret: "{{secrets.hmacSecret}}"
  sign: "{method}\n{path}\n{timestamp}\n{body.sha256}"
  headers:
    X-Signature: "{sig}"
    X-Timestamp: "{timestamp}"

auth:
  scheme: jwt
  sign:
    algorithm: RS256
    privateKey: "{{secrets.jwtPrivateKey}}"
    claims:
      iss: "{{env.tenant}}"
      aud: "{{baseUrl}}"
      exp: "+5m"
```

Token caches are stored under `.httpi/auth/` keyed by `cacheKey`. Tokens are never written to tracked files or unredacted artifacts.

**Principle check.** Each scheme is a closed vocabulary. Signing templates use a documented mini-grammar, not user code. Blocks under `httpi/blocks/auth/` stay pure data.

**Priority.** **P0** for `bearer`, `basic`, `oauth2-client-credentials`, `hmac`, and `oauth2-authorization-code` (local redirect). **P1** for `aws-sigv4`, `mtls`, `jwt`. **P2** for device-code, on-behalf-of.

---

#### D2. Automatic token refresh mid-run

**What.** When a step returns 401 on a session that holds a `refresh_token`, refresh once and retry the step.

**Why.** P6, P1, P5.

**How.** Declared on the auth scheme with `refreshOn401: true` (default when a refresh flow exists). Refresh attempts emit explicit events and are visible in artifacts as a separate attempt record.

**Principle check.** Explicit flag, not silent. Operators can disable per-request.

**Priority.** **P1**.

---

#### D3. Pluggable secret resolvers

**What.** Add resolver kinds beyond `$ENV:NAME` and `.httpi/secrets.yaml`: HashiCorp Vault, AWS Secrets Manager, 1Password CLI, Azure Key Vault, GCP Secret Manager, and the OS keychain.

**Why.** P5, P8 block adoption without this. P6 soft-requires it.

**How.** A resolver table in `httpi/config.yaml` (NOT `.httpi/`, because resolver *configuration* is project intent; only the resolved values are runtime-only):

```yaml
secrets:
  resolvers:
    - kind: env
      prefix: HTTPI_
    - kind: vault
      address: "{{$ENV:VAULT_ADDR}}"
      auth: approle
      roleIdEnv: VAULT_ROLE_ID
      secretIdEnv: VAULT_SECRET_ID
      mount: kv
    - kind: onepassword
      vault: Engineering
```

A secret reference resolves to the first resolver that returns a value:

```yaml
auth:
  scheme: bearer
  token: "{{secrets.slackBotToken}}"
```

Resolved values never touch disk. They are redacted in all event and artifact output. Resolution errors produce explicit, structured diagnostics.

**Principle check.** Resolver config is tracked intent; values are runtime-only. Matches the existing split perfectly.

**Priority.** **P1** (env + file stays P0; Vault / 1Password in the same batch as D1 enterprise schemes).

---

#### D4. Environment guards for production

**What.** Declare per-env safety guards that block accidental prod execution. This is the "one fat-finger" insurance P5 and P8 both demand.

**Why.** Every enterprise persona. P8: "One accidental live run ends careers."

**How.**

```yaml
# httpi/env/prod.env.yaml
schemaVersion: 1
title: Production
guards:
  requireEnv: HTTPI_CONFIRM_PROD=1
  requireFlag: "--i-know-what-im-doing"
  blockParallelAbove: 1
  blockIfBranchNotIn: [main]
  denyHosts:
    - "*.staging.example.com"
values:
  baseUrl: https://api.example.com
```

Running against a guarded env without meeting conditions fails with exit code `2` and a structured diagnostic. The MCP adapter surfaces guards as a required-approval payload.

**Principle check.** Declarative, in tracked files. Every gate is inspectable.

**Priority.** **P0**. Two personas rate this as a hard dealbreaker.

---

#### D5. Webhook signature verification helpers

**What.** A small declared vocabulary of signature verifiers: Stripe, GitHub, Svix, Slack, generic HMAC-SHA256 over raw body with timestamp tolerance.

**Why.** P5, P6, P8, P1. All personas note webhook verification is copy-pasted wrong constantly.

**How.** Used inside `waitForWebhook` (see C4) and as a standalone `expect` helper for webhook-received payloads captured as fixtures.

**Principle check.** Closed vocabulary, no scripts.

**Priority.** **P1**.

---

#### Group D — Validation and verification

> **Status (2026-04-12).** Shipped in the pre-loop scaffold and retained: D1
> `bearer`, `basic`, `header`, `oauth2-client-credentials`, `hmac` schemes in
> `packages/contracts/src/index.ts` / `packages/execution/src/request-resolution.ts`;
> D3 env + `.httpi/secrets.yaml` resolvers (`packages/runtime/src/secrets.ts`);
> D4 environment guards (`envGuards.blockParallelAbove` enforced in
> `executeParallelStep`, `guards` block parsed in env files).
>
> **Deferred to scope-extension work** (each is its own multi-turn
> implementation):
> - **D1 `oauth2-authorization-code`** (local redirect listener + PKCE).
> - **D1 `aws-sigv4`** (canonical request construction + region/service scoping).
> - **D1 `mtls`** (custom `https.Agent` with cert/key/CA + handshake diagnostics).
> - **D1 `jwt`** (RS256/HS256 signer + claims with `+Xm` relative exp).
> - **D2 refresh-on-401** (per-attempt hook for OAuth2 refresh flow).
> - **D3 pluggable resolvers** (Vault, 1Password, Azure Key Vault, GCP SM,
>   OS keychain) — each resolver adapter.
> - **D5 webhook signature verifiers** (Stripe/GitHub/Svix/Slack) — blocked
>   by C4 `waitForWebhook` listener.
>
> PM/QA pin at B+ on fixture coverage, matching Groups A/B/C.

**Automated checks (CI / agent-executable):**

- [x] **D1 `bearer` scheme.** Configure `auth.scheme: bearer` with a token variable. Verify the outbound request has `Authorization: Bearer <token>`. Verify the token value is redacted in all artifacts and CLI output.
- [x] **D1 `basic` scheme.** Configure basic auth. Verify the `Authorization: Basic <base64>` header is correct. Verify the decoded credential never appears in artifacts.
- [x] **D1 `oauth2-client-credentials`.** Set up a mock OAuth2 token endpoint. Verify httpi calls the token endpoint with correct `grant_type`, `client_id`, `client_secret`, and `scope`. Verify the access token is attached to the subsequent request. Verify the token is cached under `.httpi/auth/` keyed by `cacheKey`. Run a second request; verify no second token call (cache hit).
- [ ] **D1 `oauth2-authorization-code` (local redirect).** Verify the local listener starts, an authorize URL is generated correctly (with PKCE `code_challenge` if applicable), and after simulating the redirect callback, the token exchange completes. Verify the token is cached and the listener shuts down.
- [x] **D1 `hmac` signing.** Configure HMAC with a known secret and signing template. Verify the generated signature matches a reference implementation's output for the same inputs. Verify `X-Signature` and `X-Timestamp` headers are present on the outbound request.
- [ ] **D1 `aws-sigv4`.** Configure AWS SigV4 with static credentials. Verify the `Authorization` header matches the expected SigV4 signature for the given method, path, headers, and body (compare against AWS SDK reference output).
- [ ] **D1 `mtls`.** Configure mTLS with test certificates. Verify the TLS handshake uses the client cert (inspect via mock server TLS context). Verify connections fail gracefully with a clear diagnostic when the cert/key is invalid or the CA doesn't match.
- [ ] **D1 `jwt` sign.** Configure JWT signing with RS256 and a test private key. Verify the generated JWT decodes correctly with the matching public key, contains the declared claims (`iss`, `aud`), and `exp` is correctly computed from `"+5m"` relative to current time.
- [x] **D1 secret redaction.** For every auth scheme: verify that secrets (`clientSecret`, `hmacSecret`, `privateKey`, `keyPassphrase`, token values) NEVER appear in artifacts, CLI output, MCP responses, or event payloads. Search all artifact files for the literal secret value; assert zero matches.
- [ ] **D2 auto-refresh.** Configure an OAuth2 session with a token that expires immediately. Fixture returns 401 on first attempt. Verify httpi refreshes the token (one call to the token endpoint with `grant_type=refresh_token`) and retries the step. Verify the retry succeeds with the new token. Verify artifacts show two attempts: one 401, one 200.
- [ ] **D2 refresh disabled.** Set `refreshOn401: false`. Verify a 401 is treated as a terminal failure with no refresh attempt.
- [ ] **D2 refresh failure.** Mock the token endpoint to also return an error on refresh. Verify the step fails with a diagnostic that names the refresh failure, not just "401".
- [ ] **D3 resolver chain.** Configure three resolvers: `env`, `vault` (mock), `onepassword` (mock). Set a secret in the env resolver only. Verify it resolves. Remove it from env, add it to vault mock. Verify vault supplies it. Verify the resolved value never touches disk.
- [ ] **D3 resolution failure.** Reference a secret that no resolver can provide. Verify a structured diagnostic listing which resolvers were tried and what each returned.
- [ ] **D3 resolver config in tracked file.** Verify `secrets.resolvers` config lives in `httpi/config.yaml` (tracked), not in `.httpi/`. Verify the resolved values are runtime-only and never written to any tracked file.
- [x] **D4 environment guard — missing env var.** Configure `guards.requireEnv: HTTPI_CONFIRM_PROD=1`. Run without setting the variable. Verify exit code 2 and a structured diagnostic naming the missing guard condition.
- [x] **D4 environment guard — wrong branch.** Configure `guards.blockIfBranchNotIn: [main]`. Run on a feature branch. Verify exit code 2.
- [ ] **D4 environment guard — MCP approval.** Via MCP, attempt to run against a guarded env. Verify the response includes a required-approval payload with the guard conditions listed.
- [x] **D4 all guards combined.** Configure multiple guards simultaneously. Verify ALL must pass, not just one.
- [ ] **D5 webhook verifier — Stripe.** Compute a valid Stripe signature for a known payload and secret. Verify the verifier accepts it. Alter one byte of the payload; verify rejection. Set the timestamp outside `toleranceSeconds`; verify rejection.
- [ ] **D5 webhook verifier — GitHub.** Same pattern with GitHub's `X-Hub-Signature-256` HMAC scheme.
- [ ] **D5 webhook verifier — generic HMAC-SHA256.** Verify against a hand-computed reference signature.

**Human review checkpoints:**

- [x] Review every auth scheme implementation for secret lifecycle: confirm the secret is resolved into memory, used for header/signature computation, and then NOT stored anywhere (no writing to disk, no logging, no inclusion in event payloads).
- [ ] Verify `.httpi/auth/` token cache files are encrypted or at minimum excluded from any export/audit command. Confirm they are cleaned up on `httpi clean`.
- [x] Review the HMAC signing template mini-grammar parser. Confirm it is a closed substitution grammar (`{method}`, `{path}`, `{timestamp}`, `{body.sha256}`) — no arbitrary expressions, no `eval`.
- [ ] Verify `oauth2-authorization-code` local redirect listener validates the `state` parameter to prevent CSRF.
- [ ] Review D4 guard evaluation order. Confirm guards are evaluated BEFORE any request compilation or secret resolution occurs — a guarded env must not trigger vault calls.
- [ ] Audit the `denyHosts` guard implementation. Confirm it checks the resolved URL's hostname, not just the template string, to prevent bypasses via variable indirection.

---

### Group E — Agent-facing ergonomics

#### E1. Compact, token-efficient MCP responses with summarization on read

**What.** MCP tool responses default to compact summaries: status, duration, assertion results, artifact paths, body shape. Full bodies are only returned when the caller explicitly asks (`includeBody: true` or `readArtifact` with an explicit range or JMESPath).

**Why.** P4: "Context window is the #1 scarce resource. A single 2MB response can poison the session."

**How.**

- `run_definition`, `resume_session`, and `get_session_state` return a fixed, bounded result shape with `artifactIndex` pointers instead of inlined bodies.
- `read_artifact` adds optional `summary: true` (default) which returns top-level keys, types, array lengths, and a truncated preview.
- Add `read_artifact` with `jmespath: "..."` or `jsonPath: "..."` for targeted extraction.
- CLI `httpi artifacts read` gains `--summary`, `--full`, and `--jq <expr>` flags.

**Principle check.** Parity: CLI and MCP expose identical summarization flags. Redaction still applies.

**Priority.** **P0**.

---

#### E2. Structured diagnostics with file:line

**What.** Every diagnostic (validation, assertion, drift, type error) includes `{ file, line, column, code, message, hint }`.

**Why.** P4: "Agents fix what they can locate precisely." P2, P7 also want this.

**How.** `packages/contracts` gains a canonical `Diagnostic` type. YAML loader in `packages/definitions` already knows the file/line positions of each key — plumb them through. CLI prints with a `file:line` prefix; MCP returns them as structured objects.

**Principle check.** Already inside the v0 design goal "Validation results must be structured and include file and line information when available." This improvement makes it unconditional.

**Priority.** **P0**.

---

#### E3. Mutation gating: safe-by-default for destructive methods

**What.** Any step with `POST`, `PUT`, `PATCH`, or `DELETE` — or any step explicitly flagged `mutates: true` — pauses for approval before execution unless the run file or invocation explicitly confirms.

**Why.** P4 (coding agents are the primary customer), P2, P8. Agents and humans both benefit from "describe before act" on destructive surfaces.

**How.**

```yaml
kind: run
confirmation:
  mutating: pause-before   # default: pause-before | allow | require-explicit-step
  overrides:
    - step: login
      allow: true
```

Runs launched with `httpi run --confirm-all` or MCP `run_definition` with `confirmMutating: true` proceed without pausing. Otherwise the run reaches a synthetic pause step before each mutating attempt and surfaces a structured approval request.

**Principle check.** Matches the existing "inspectable over magical" principle. Pause state is a first-class construct already.

**Priority.** **P0** (feature flag, default on, configurable).

---

#### E4. First-class authoring scaffolds

**What.** New CLI + MCP commands that generate schema-valid request, run, env, and block files:

- `httpi new request <path> [--method POST] [--url ...]`
- `httpi new run <path> --from <requestId> [...]`
- `httpi new env <name>`
- `httpi new block auth/<name>`

**Why.** P4: "Agents get it right on the first write instead of thrashing."

**How.** Emit files with `yaml-language-server` `$schema` comments, inline explanatory comments keyed off the JSON Schema, and safe placeholder values. MCP `scaffold_definition` exposes the same generators.

**Principle check.** No identity drift; scaffolds produce path-consistent files.

**Priority.** **P1**.

---

#### E5. Single-step replay with captured variable snapshot

**What.** `httpi replay <sessionId> --step <stepId>` re-executes exactly one step against the variable snapshot captured at the original attempt, producing a new attempt artifact sibling.

**Why.** P4: "The innermost debug loop." P1: "Incident replay from days into minutes."

**How.** Each step persists a `variables.snapshot.json` at attempt time. Replay loads that snapshot, re-runs the step through the existing execution engine, and writes a new `attempt-N/` folder. The parent session state does NOT transition — replays are read-only from a session-state perspective.

**Principle check.** Fits the existing artifact-first model. Explicit, no hidden state.

**Priority.** **P1**.

---

#### E6. Variable provenance everywhere

**What.** `explain_variables` already exists. Extend it so every resolved value includes `{ value, source, definedAt }` and every assertion failure message includes the provenance of every variable it references.

**Why.** P4: "Eliminates 90% of 'why is this value wrong' debugging loops."

**How.** The run compiler already tracks precedence — record `definedAt` (file:line for tracked values, `env-var:NAME` for direct env reads, `step.id.extracted.field` for extracted values) and thread it through the `Diagnostic` type from E2.

**Principle check.** Already aligned. This is a depth improvement, not a new surface.

**Priority.** **P1**.

---

#### E7. `httpi lint`

**What.** A static linter that flags unused variables, unreachable steps, missing assertions, orphan fixtures, inconsistent capture policies, and any secret literal in tracked files.

**Why.** P4, P5. Both personas list it as a "clear adoption amplifier."

**How.** A new command and package `packages/lint` reusing the existing `packages/definitions` loader. Output uses the `Diagnostic` shape from E2.

**Principle check.** Purely analytical. No execution side effects.

**Priority.** **P2**.

---

#### Group E — Validation and verification

> **Status (2026-04-12).** **E2 structured diagnostics** is fully shipped
> (rows 1231–1234 already marked pre-loop; `Diagnostic`, `EnrichedDiagnostic`,
> `file/line/column/code/hint` in `packages/contracts/src/index.ts` and
> `finalizeDiagnostic` in `packages/definitions`). **E6 variable
> provenance** is partially shipped via `explain_variables` +
> `redactVariableExplanations` with `{ value, source, secret }`.
>
> **Deferred to scope-extension work:**
> - **E1 compact MCP responses** — `read_artifact` summary mode, jsonPath/jmespath slicing, token-budget bounded output across `run_definition`/`resume_session`/`get_session_state`.
> - **E3 mutation gating** — `MutationConfirmation` type exists in contracts but executor wiring + `--confirm-all` + MCP approval payload remain.
> - **E4 scaffolds** — `httpi new request|run|env|block` + MCP `scaffold_definition` tool.
> - **E5 single-step replay** — `variables.snapshot.json` capture + `httpi replay <sessionId> --step <stepId>`.
> - **E6 `definedAt` provenance + assertion-failure variable traces.**
> - **E7 `httpi lint`** — new `packages/lint` package; unused-var / unreachable / missing-assertion / secret-literal rules.
>
> PM/QA pin at B+ on fixture coverage, matching prior groups.

**Automated checks (CI / agent-executable):**

- [ ] **E1 compact MCP response.** Execute a request that returns a 50 KB JSON body via MCP `run_definition`. Verify the response does NOT inline the body. Verify it includes `artifactIndex` pointers, status, duration, and assertion results. Measure the response token count; assert it is < 2000 tokens.
- [ ] **E1 `read_artifact` summary mode.** Call `read_artifact(sessionId, stepId, summary: true)`. Verify the output includes top-level keys, types, array lengths, and a truncated preview. Verify the full body is NOT returned.
- [ ] **E1 `read_artifact` with JMESPath/JSONPath.** Call `read_artifact` with `jmespath: "user.name"`. Verify only the extracted value is returned, not the full body.
- [ ] **E1 CLI parity.** Run `httpi artifacts read <path> --summary` and `--full`. Verify `--summary` matches the MCP summary mode output. Verify `--jq` produces equivalent results to MCP's `jmespath`.
- [x] **E2 structured diagnostic — validation error.** Load a YAML file with a typo in a required field. Verify the diagnostic includes `{ file, line, column, code, message, hint }` and that `file:line` points to the exact YAML key.
- [x] **E2 structured diagnostic — assertion failure.** Run an assertion that fails. Verify the diagnostic includes `file:line` pointing to the `expect:` block in the YAML definition.
- [x] **E2 structured diagnostic — drift detection.** Modify a tracked file between pause and resume. Verify the drift diagnostic includes `file:line` for the changed definition.
- [x] **E2 CLI output format.** Verify CLI prints diagnostics with a `file:line` prefix (e.g., `httpi/requests/users/get.yaml:12: error[E001]: ...`). Verify MCP returns them as structured JSON objects.
- [ ] **E3 mutation gating — default pause.** Create a run with a `POST` step. Run without `--confirm-all`. Verify the run pauses before the POST step with a structured approval request. Resume; verify the step executes.
- [ ] **E3 mutation gating — `allow` override.** Set `confirmation.overrides: [{ step: login, allow: true }]` on a POST step. Verify it does NOT pause.
- [ ] **E3 mutation gating — `--confirm-all`.** Run with `--confirm-all`. Verify no mutation pauses occur.
- [ ] **E3 mutation gating — `mutates: true` flag.** Mark a GET request with `mutates: true`. Verify it triggers the mutation gate.
- [ ] **E3 MCP approval payload.** Via MCP, trigger a mutation pause. Verify the response includes the step details, method, URL, and a structured approval field the agent can act on.
- [ ] **E4 scaffold — request.** Run `httpi new request users/get-me --method GET --url "{{baseUrl}}/me"`. Verify the file is created at the correct path, contains valid YAML with a `$schema` comment, uses the declared method and URL, and passes `httpi lint` (once E7 exists) or at minimum loads without validation errors.
- [ ] **E4 scaffold — run.** Run `httpi new run users/crud --from users/get-me`. Verify the run file references the request by path-derived ID.
- [ ] **E4 scaffold — MCP parity.** Execute `scaffold_definition` via MCP. Verify the output matches CLI behavior.
- [ ] **E5 single-step replay.** Run a session. Then run `httpi replay <sessionId> --step <stepId>`. Verify a new `attempt-N/` folder is created under the step's artifacts with the replayed response. Verify the parent session state does NOT change (remains `completed` or whatever it was).
- [ ] **E5 variable snapshot.** Verify `variables.snapshot.json` exists for the step. Modify an environment variable after the original run. Replay; verify the replayed request uses the ORIGINAL variable values from the snapshot, not the current env.
- [ ] **E6 variable provenance.** Run `explain_variables` for a resolved value. Verify the output includes `{ value, source, definedAt }` where `definedAt` is `file:line` for tracked values, `env-var:NAME` for env values, and `step.id.extracted.field` for extracted values.
- [ ] **E6 provenance in assertion failures.** Trigger an assertion failure that references a variable. Verify the diagnostic message includes the provenance of that variable.
- [ ] **E7 lint — unused variable.** Declare a variable in env that is never referenced. Run `httpi lint`. Verify a warning diagnostic with `file:line` pointing to the unused declaration.
- [ ] **E7 lint — unreachable step.** Create a `switch` where no case can reach a particular step. Verify lint flags it.
- [ ] **E7 lint — missing assertion.** Create a request with no `expect` block. Verify lint warns about it.
- [ ] **E7 lint — secret literal.** Place a string that looks like an API key (e.g., `sk-live-abc123`) directly in a tracked YAML file. Verify lint flags it as a critical error.
- [ ] **E7 lint diagnostic format.** Verify lint output uses the `Diagnostic` shape from E2.

**Human review checkpoints:**

- [ ] Review E1 summarization logic. Confirm it handles edge cases: empty response bodies, non-JSON bodies, deeply nested objects (verify truncation depth is bounded), arrays with thousands of elements (verify only length is reported, not content).
- [ ] Verify E3 mutation gating cannot be bypassed by sending a method as lowercase (e.g., `post` vs `POST`). Confirm the check is case-insensitive.
- [ ] Review E4 scaffold templates. Confirm they produce files that are valid against the current JSON Schema for each definition kind. Confirm placeholder values are clearly marked (e.g., `"{{TODO}}"`) and would fail validation if left unchanged.
- [ ] Verify E5 replay does NOT re-execute side effects on the server beyond the single replayed request. Confirm the session state machine rejects any attempt to transition based on replay results.
- [ ] Review E7 lint rules for false-positive rates. Confirm the secret literal detector uses entropy analysis or known prefix patterns (e.g., `sk-live-`, `ghp_`, `AKIA`), not just "long string" heuristics.

---

### Group F — CI, reporting, and developer flow

#### F1. CI reporters (JUnit, TAP, GitHub Actions annotations)

**What.** `httpi run` accepts `--reporter=junit|tap|github|json` with stable on-disk paths. Non-zero exit codes map cleanly to CI expectations.

**Why.** P2, P4, P5, P7, P8. P7: "If it doesn't block a PR, it doesn't get adopted."

**How.** New `packages/reporters/` (leaf utility package) with one reporter per format. CLI writes to a configurable path (`--reporter junit:./.httpi/reports/junit.xml`). GitHub reporter emits `::error file=...,line=...` annotations derived from E2 diagnostics.

**Principle check.** Parity preserved — MCP returns the same structured results and a reporter URI.

**Priority.** **P0**.

---

#### F2. `summary.json` + per-run human-readable digest

**What.** Every run writes a machine-readable `summary.json` (pass/fail counts, token totals, cost estimate, latency percentiles, assertion breakdown, drift state) and a short `summary.md` suitable for pasting into PRs.

**Why.** P4, P7.

**How.** Both artifacts live under `.httpi/responses/<sessionId>/`. `summary.md` uses a stable, minimal template — no frills, just facts.

**Priority.** **P1**.

---

#### F3. `httpi diff <sessionA> <sessionB>`

**What.** Structured diff between two sessions: status changes, latency deltas, assertion deltas, cost deltas, body diffs as JSON Patch.

**Why.** P1, P5, P7.

**How.** A read-only command operating on artifact directories. Output defaults to a terse terminal table with an optional `--json` mode and `--only assertions|latency|cost|body` filters.

**Priority.** **P1**.

---

#### Group F — Validation and verification

> **Status (2026-04-12).** Landed this loop: **F1 JSON reporter** via
> `httpi run --reporter json[:path]` writing the full execution result
> (assertions + diagnostics + session state) to `.httpi/reports/run.json`
> or a caller-specified path (`apps/cli/src/index.ts` `maybeWriteReporter`).
> Exit codes already satisfy F1 exit-code rules: 0 on success, 1
> (`executionFailure`) on assertion/HTTP failure, 2 (`validationFailure`)
> for config/guard errors.
>
> **Deferred to scope-extension work:** F1 JUnit XML, TAP 14, and GitHub
> Actions `::error file=...,line=...` annotations; F2 `summary.json` /
> `summary.md`; F3 `httpi diff <sessionA> <sessionB>`. Each is multi-turn
> (reporter-per-format + templates + diff walker).
>
> PM/QA pin at B+ on fixture coverage, matching prior groups.

**Automated checks (CI / agent-executable):**

- [ ] **F1 JUnit output.** Run a session with 3 passing steps and 1 failing step using `--reporter=junit:./.httpi/reports/junit.xml`. Parse the XML. Verify it is valid JUnit XML with correct `<testsuite>` counts (`tests="4"`, `failures="1"`), each `<testcase>` has `name`, `classname`, and `time` attributes, and the failure includes the assertion message.
- [ ] **F1 TAP output.** Same session with `--reporter=tap`. Verify the output conforms to TAP 14 format: plan line, `ok`/`not ok` per step, diagnostic lines for failures.
- [ ] **F1 GitHub Actions annotations.** Run with `--reporter=github`. Verify `::error file=...,line=...::message` annotations are emitted to stdout for each failure. Verify `file` and `line` match the YAML source location from E2 diagnostics.
- [x] **F1 JSON reporter.** Run with `--reporter=json`. Verify the output is valid JSON with the same structured assertion results as MCP returns.
- [x] **F1 exit codes.** Verify exit code 0 when all assertions pass, exit code 1 when any assertion fails, and exit code 2 for configuration/validation errors (e.g., guard failures from D4).
- [ ] **F1 multiple reporters.** Run with `--reporter=junit:a.xml --reporter=github`. Verify both outputs are produced.
- [ ] **F1 MCP parity.** Run the same session via MCP. Verify the structured result includes a `reporterUri` field (or equivalent) pointing to the generated report file.
- [ ] **F2 `summary.json`.** After a run, verify `.httpi/responses/<sessionId>/summary.json` exists and contains: `passCount`, `failCount`, `totalSteps`, `totalLatencyMs`, assertion breakdown (by type), and drift state.
- [ ] **F2 `summary.md`.** Verify `summary.md` exists alongside `summary.json`, is valid Markdown, and includes a concise table of step outcomes. Verify it is stable across identical runs (no timestamps or random content that would cause noisy PR diffs).
- [ ] **F2 token/cost fields.** If H2 token accounting is also implemented, verify `summary.json` includes `totalTokens`, `totalCost`, and per-model breakdowns.
- [ ] **F3 `httpi diff` basic.** Run the same request twice (with a fixture change between runs). Run `httpi diff <sessionA> <sessionB>`. Verify the output includes status changes, latency deltas, assertion result deltas, and body diffs as JSON Patch.
- [ ] **F3 `--only` filter.** Run `httpi diff <A> <B> --only assertions`. Verify only assertion deltas are shown. Repeat for `--only latency`, `--only cost`, `--only body`.
- [ ] **F3 `--json` mode.** Run `httpi diff <A> <B> --json`. Verify the output is valid JSON with the same data as the terminal table.
- [ ] **F3 nonexistent session.** Run `httpi diff <validId> <invalidId>`. Verify a clear error, not a crash.

**Human review checkpoints:**

- [ ] Review JUnit XML generation against the de facto JUnit schema (used by Jenkins, GitHub Actions, CircleCI). Confirm `classname` uses a stable, meaningful identifier (e.g., the run file path) and `name` uses the step ID.
- [ ] Verify GitHub annotations use the correct `::error` / `::warning` syntax and that the `file` path is relative to the repo root (not absolute), so GitHub can render them inline on PRs.
- [ ] Confirm `summary.md` template is minimal and does not include marketing language, emojis, or verbose descriptions. It should be paste-ready for a PR comment.
- [ ] Review `httpi diff` body diff output. Confirm JSON Patch diffs are correct (RFC 6902) and that large diffs are truncated with a clear indicator rather than dumping megabytes to the terminal.

---

### Group G — Dataset fan-out, record/replay, and fixtures

#### G1. Dataset-driven fan-out (eval-style runs)

**What.** A run step can reference a dataset file and fan out one execution per row, binding row fields as step variables. Each row produces its own artifact subtree.

**Why.** P7, P1, P3 strongly; P2, P4, P6 as nice-to-haves.

**How.**

```yaml
- kind: dataset
  id: eval-prompts
  source: datasets/prompts.jsonl
  concurrency: 4
  steps:
    - kind: request
      id: chat
      uses: chat/completions
      with:
        prompt: "{{row.prompt}}"
      expect:
        body:
          contentType: json
          matches:
            kind: llm-judge
            rubric: rubrics/helpfulness.md
            passIf:
              verdict: pass
```

Supported source formats: `jsonl`, `csv`, `yaml` (array), and `http` (URL to a dataset endpoint). Artifacts live under `steps/eval-prompts/rows/<rowIndex>/`.

**Principle check.** Datasets under `httpi/datasets/` are tracked. Nothing dynamic happens outside the declared vocabulary.

**Priority.** **P0** for AI personas.

---

#### G2. Record / replay cassettes (VCR-style)

**What.** A capture mode that records real upstream traffic into redacted JSON cassettes, and a replay mode that serves them deterministically in CI.

**Why.** P1, P3, P6, P7. P6: "CI cannot hit live third parties; mocks rot."

**How.**

```yaml
# httpi/config.yaml
cassettes:
  dir: httpi/cassettes
  match: [method, url, body.hash]
  redact:
    headers: [authorization, cookie]
    jsonPath:
      - $.account_number
```

- `httpi run --record <runId>`: stores per-interaction JSON files under `httpi/cassettes/<runId>/`.
- `httpi run --replay <runId>`: matches outbound requests against cassettes; a miss is a run failure by default.
- Cassettes are tracked (PR-reviewable) unless the operator declares a cassette as sensitive, in which case it lives under `.httpi/cassettes/`.

**Principle check.** Cassettes as tracked artifacts is a new twist but stays data-only. Redaction is declarative.

**Priority.** **P1**.

---

#### G3. HAR import → request scaffold

**What.** `httpi import har <file>` emits a set of request files and (optionally) a run file derived from a browser HAR.

**Why.** P5, P6. Kills the "we used to do this in Postman" migration friction.

**How.** Deterministic path derivation from HAR entries. Secrets and tokens are stripped to placeholders. Output is a scaffold — human review is expected before merge.

**Principle check.** Output is tracked data. No execution side effects at import time.

**Priority.** **P2**.

---

#### Group G — Validation and verification

> **Status (2026-04-12).** **Deferred to scope-extension work** — every G
> item is a net-new surface requiring substantial multi-turn implementation.
> None were reachable in this loop without preempting Groups H–J:
>
> - **G1 dataset fan-out** — new `kind: dataset` step + JSONL/CSV/YAML/HTTP
>   parsers + per-row artifact subtrees + concurrency cap. Closest
>   existing primitive is B6 `iterate` in `packages/execution/src/iterate-execution.ts`; a follow-up can refactor that into a shared fan-out executor.
> - **G2 record/replay cassettes** — new `--record` / `--replay` modes,
>   cassette matcher, cassette redaction, `.httpi/cassettes/` vs
>   `httpi/cassettes/` split for sensitive recordings.
> - **G3 HAR import** — new `httpi import har <file>` command emitting
>   path-deterministic request YAMLs with secret placeholders.
>
> PM/QA pin at B+ on fixture coverage, matching prior groups. The
> deferred list is explicit and each item's landing plan is documented
> inline above for the follow-up work stream.

**Automated checks (CI / agent-executable):**

- [ ] **G1 JSONL fan-out.** Create a `datasets/prompts.jsonl` with 5 rows. Configure a `kind: dataset` step with `concurrency: 2`. Verify exactly 5 requests are made. Verify artifacts exist under `steps/<datasetStepId>/rows/0/` through `rows/4/`, each containing full request/response pairs.
- [ ] **G1 CSV fan-out.** Same test with a CSV source. Verify column headers are mapped to `row.<header>` variables correctly.
- [ ] **G1 YAML array fan-out.** Same test with a YAML array source. Verify each array element is accessible as `row.<field>`.
- [ ] **G1 row variable binding.** In the step template, reference `{{row.prompt}}`. Verify each row's request body contains the correct per-row prompt value.
- [ ] **G1 per-row assertions.** Add an `expect` block on the dataset step's inner request. Verify assertions run independently per row. Verify the run-level summary reports per-row pass/fail counts.
- [ ] **G1 concurrency cap.** With `concurrency: 1` and 5 rows each taking 200 ms, verify total time ≥ 1000 ms. With `concurrency: 5`, verify ≈ 200 ms.
- [ ] **G1 empty dataset.** Run with an empty JSONL file. Verify the step completes successfully with 0 iterations and a clear diagnostic noting the empty dataset.
- [ ] **G1 malformed dataset.** Run with a JSONL file containing an invalid JSON line. Verify a structured diagnostic with the file path and line number of the bad record.
- [ ] **G1 tracked dataset location.** Verify datasets referenced as `datasets/prompts.jsonl` resolve under `httpi/datasets/`, not `.httpi/`.
- [ ] **G2 record mode.** Run `httpi run --record <runId>` against a live fixture server. Verify cassette files are written under `httpi/cassettes/<runId>/` with one JSON file per interaction. Verify each cassette contains method, URL, request headers (redacted), request body, response status, response headers (redacted), and response body (redacted per J2 rules).
- [ ] **G2 replay mode — match.** Run `httpi run --replay <runId>`. Verify no outbound HTTP calls are made (mock server receives zero requests). Verify the responses served from cassettes produce identical assertion results as the original run.
- [ ] **G2 replay mode — miss.** Modify a request URL so it no longer matches any cassette. Run in replay mode. Verify the run fails with a diagnostic identifying the unmatched request.
- [ ] **G2 cassette matching.** Verify the `match` strategy (`[method, url, body.hash]`) correctly distinguishes two POST requests to the same URL with different bodies.
- [ ] **G2 cassette redaction.** Verify sensitive headers (`authorization`, `cookie`) and JSONPath patterns declared in `cassettes.redact` are replaced with placeholders in the cassette files.
- [ ] **G2 cassette PR-reviewability.** Verify cassette files are valid JSON, human-readable, and diffable in a PR. Confirm they do not contain binary blobs or base64-encoded bodies for JSON responses.
- [ ] **G3 HAR import.** Import a sample HAR file with 5 entries. Verify 5 request YAML files are generated at deterministic paths. Verify tokens and cookies are replaced with `{{secrets.TODO}}` placeholders. Verify the generated files load without validation errors.
- [ ] **G3 HAR import — run file.** Import with the `--run` flag. Verify a run file is generated that references all imported requests in order.
- [ ] **G3 HAR import — no execution.** Verify the import command does NOT execute any requests. It only writes files.

**Human review checkpoints:**

- [ ] Review G1 dataset parsing for injection safety. Confirm that row values used in `{{row.X}}` templates are treated as literal values and cannot inject YAML structure, additional template expressions, or escape the variable boundary.
- [ ] Verify G2 cassette matching handles non-deterministic request fields (e.g., timestamps in bodies, random UUIDs in headers) gracefully. Confirm the `body.hash` strategy hashes the body AFTER applying redaction/masking, so volatile fields don't break matching.
- [ ] Review G3 HAR import path derivation. Confirm the mapping from HAR entry URL to file path is deterministic, avoids path traversal (no `../`), and handles query parameters and fragments safely.
- [ ] Confirm G2 sensitive cassette files (declared as sensitive by the operator) correctly land under `.httpi/cassettes/` instead of `httpi/cassettes/` and are `.gitignore`-d.

---

### Group H — Observability and tracing

#### H1. OpenTelemetry trace export

**What.** Every run emits OTel spans for the run, each step, each attempt, and each stream chunk (optional). Export targets: local `otlp.jsonl`, OTLP/HTTP endpoint, OTLP/gRPC endpoint.

**Why.** P2, P7. P7: "Lets customers dogfood our own platform on their httpi runs."

**How.** New `packages/telemetry` module that consumes the existing event stream and emits OTel spans. Configured in `httpi/config.yaml`:

```yaml
telemetry:
  otel:
    enabled: true
    exporter:
      kind: otlp-http
      endpoint: "{{$ENV:OTLP_ENDPOINT}}"
    resource:
      service.name: httpi
      service.version: "0.2"
    spans:
      streamChunks: false
```

Trace IDs must be stable across pause and resume (derive deterministically from `sessionId` + attempt counter).

**Principle check.** Runtime-only. Redaction of span attributes matches artifact redaction.

**Priority.** **P1**.

---

#### H2. Token and cost accounting per step and run

**What.** Parse `usage` fields from OpenAI, Anthropic, Bedrock, Google, and custom response shapes, aggregate per step / run / model, and attach dollar estimates from a configurable price table.

**Why.** P1, P2, P4, P7. P4: "Budget regressions are customer-visible and must fail CI."

**How.** An opt-in response interpreter declared on request files:

```yaml
response:
  interpret:
    kind: llm-usage
    provider: anthropic
```

Adds `usage` and `cost` fields to the step's `summary.json` and the run-level `summary.json`. Price tables live in `httpi/prices/*.yaml` (tracked, updatable).

**Principle check.** Declarative interpreter, closed vocabulary per provider.

**Priority.** **P1**.

---

#### H3. Chaos injection (local only)

**What.** Declaratively inject latency, timeouts, and partial responses into a request at test time, for resilience validation.

**Why.** P5, P1. P5: "Validates our gateway's resilience story for AI streaming."

**How.**

```yaml
chaos:
  delayMs: 300
  failureRate: 0.1
  failureClass: timeout
  truncateAfterBytes: 1024
```

Chaos only applies when the request's env resolves to a declared `chaos-safe` marker. Never runs against guarded prod envs.

**Principle check.** Scoped, declarative, env-guarded.

**Priority.** **P2**.

---

#### Group H — Validation and verification

> **Status (2026-04-12).** **Deferred to scope-extension work.** Group H
> items each require substantial new packages/modules beyond the loop's
> incremental cadence:
>
> - **H1 OTel export** — new `packages/telemetry`, span tree derived from
>   the existing `appendSessionEvent` stream, OTLP/HTTP + OTLP/gRPC +
>   `otlp.jsonl` exporters, stable trace IDs across pause/resume, span
>   redaction mirroring artifact redaction.
> - **H2 token/cost accounting** — `response.interpret.kind: llm-usage`
>   declarative interpreter per provider (Anthropic/OpenAI/Bedrock/Google),
>   price tables in `httpi/prices/`, integer-minor-unit cost math,
>   run-level aggregation.
> - **H3 chaos injection** — fetch-layer delay/timeout/truncation primitives,
>   `chaos-safe` env marker gate, no-op in guarded prod envs.
>
> PM/QA pin at B+ on fixture coverage.

**Automated checks (CI / agent-executable):**

- [ ] **H1 OTel span structure.** Run a session with 3 sequential steps. Enable `telemetry.otel` with `exporter.kind: otlp-http` pointed at a mock collector. Verify the collector receives: 1 root span (the run), 3 child spans (one per step), each with correct `traceId`, `spanId`, `parentSpanId` relationships. Verify span names include the step ID.
- [ ] **H1 attempt spans.** Enable retries on a step that fails once then succeeds. Verify 2 attempt spans exist as children of the step span, with the first marked as an error.
- [ ] **H1 stream chunk spans.** Enable `spans.streamChunks: true` on a streaming request with 5 chunks. Verify 5 chunk spans exist under the step span. Disable the flag; verify no chunk spans are emitted.
- [ ] **H1 trace stability across pause/resume.** Pause a run mid-step, then resume. Verify the `traceId` is identical before and after resume. Verify the resumed step span has the same parent as it would have without the pause.
- [ ] **H1 `otlp.jsonl` local export.** Configure local file export. Verify `.httpi/telemetry/otlp.jsonl` is written with one JSON object per span, parseable by standard OTel tooling.
- [ ] **H1 redaction in spans.** Verify span attributes do not contain secret values. Configure a redaction rule; verify the corresponding span attribute is redacted.
- [ ] **H2 token accounting — Anthropic.** Configure `response.interpret.kind: llm-usage, provider: anthropic`. Send a response with a standard Anthropic `usage` block. Verify the step's `summary.json` includes `usage.input_tokens`, `usage.output_tokens`, and `cost` computed from the price table.
- [ ] **H2 token accounting — OpenAI.** Same test with `provider: openai` and an OpenAI-shaped usage block.
- [ ] **H2 run-level aggregation.** Run 3 steps with token accounting. Verify the run-level `summary.json` aggregates totals across all steps and breaks down by model.
- [ ] **H2 price table.** Create a `httpi/prices/anthropic.yaml` with a known price. Verify the cost calculation matches `(input_tokens * input_price + output_tokens * output_price)` exactly.
- [ ] **H2 missing price table.** Reference a model not in the price table. Verify usage is captured but cost is `null` with a warning diagnostic.
- [ ] **H3 chaos — delay.** Configure `chaos.delayMs: 300` on a request. Verify the response takes ≥ 300 ms longer than the unchaosd baseline.
- [ ] **H3 chaos — failure rate.** Configure `chaos.failureRate: 1.0, failureClass: timeout`. Verify the request times out. Configure `failureRate: 0.0`; verify it succeeds.
- [ ] **H3 chaos — truncation.** Configure `chaos.truncateAfterBytes: 10` on a 1000-byte response. Verify the response body is truncated.
- [ ] **H3 chaos — env guard.** Configure chaos on a request targeting a guarded prod env. Verify chaos does NOT apply (the request executes normally). Verify chaos only applies in `chaos-safe` environments.
- [ ] **H3 chaos — no prod.** Explicitly test that `chaos` blocks on environments that do NOT have the `chaos-safe` marker, even if not guarded.

**Human review checkpoints:**

- [ ] Review H1 `traceId` derivation. Confirm it is deterministically derived from `sessionId` + attempt counter so that traces are reproducible and correlate correctly across pause/resume boundaries.
- [ ] Verify H1 OTel span attribute naming follows OTel semantic conventions (e.g., `http.method`, `http.status_code`, `http.url`) where applicable.
- [ ] Review H2 provider response parsing. Confirm it handles missing `usage` fields gracefully (some LLM responses omit usage on streaming). Confirm it does NOT crash on unexpected response shapes — it should produce a warning diagnostic and proceed.
- [ ] Verify H2 price tables are tracked under `httpi/prices/` and are simple, auditable YAML with per-model per-token-type prices. Confirm no floating-point arithmetic issues in cost calculation (use integer minor-unit math or decimal libraries).
- [ ] Review H3 chaos injection integration point. Confirm chaos is injected at the HTTP transport layer (wrapping `fetch`), not at the response parsing layer, so it accurately simulates real network conditions.

---

### Group I — Protocols and data fidelity

#### I1. GraphQL as a first-class request kind

**What.** `kind: graphql` with `query`, `variables`, and JSONPath extraction rooted at `data.*` by convention.

**Why.** P6, P1, P5.

**How.**

```yaml
kind: request
title: List repos
method: POST
url: "{{githubGraphqlUrl}}"
graphql:
  query: queries/list-repos.gql
  variables:
    login: "{{org}}"
expect:
  body:
    jsonPath:
      - path: $.data.organization.repositories.totalCount
        gte: 1
```

Tracked `.gql` files live under `httpi/graphql/`.

**Principle check.** Pure data, path-derived references.

**Priority.** **P1**.

---

#### I2. Pagination primitives (cursor, offset, Link)

**What.** Declarative auto-follow for the three dominant pagination patterns, producing a single flattened extracted array.

**Why.** P6 strongly, P3, P8.

**How.**

```yaml
paginate:
  kind: cursor
  cursor:
    in: body
    jsonPath: $.meta.next_cursor
  param:
    in: query
    name: cursor
  maxPages: 50
extract:
  items:
    from: $.data
    flatten: true
```

Also support `kind: link-header` and `kind: offset`.

**Principle check.** Same precedence model; no hidden loops.

**Priority.** **P1**.

---

#### I3. Decimal-safe money type

**What.** A typed matcher for money comparisons that never touches floating point.

**Why.** P8 dealbreaker.

**How.**

```yaml
expect:
  body:
    jsonPath:
      - path: $.amount
        money:
          value: "10.99"
          currency: usd
          mode: strict     # strict | rounded-half-even
```

The engine parses values as bigints of minor units based on `currency` and compares exactly.

**Principle check.** Closed vocabulary, explicit currency requirement.

**Priority.** **P2**.

---

#### I4. Richer JSONPath subset

**What.** Expand the v0 subset (`$`, `$.field`, `$.field.nested`, `$.items[0]`) to include:

- `$.field[*]`
- `$.field[-1]`
- `$.field[0:3]` slices
- `$.field[?(@.status == 'ok')]` — equality predicate only

**Why.** P1, P3, P6, P7.

**How.** Implement carefully in `packages/execution/variables.ts`. Keep the subset closed and explicitly documented — no recursive descent, no function calls.

**Principle check.** Extends the existing deliberate subset, does not open the door to arbitrary JSONPath.

**Priority.** **P1**.

---

#### Group I — Validation and verification

> **Status (2026-04-12).** **Deferred to scope-extension work.** Shipped
> pre-loop: v0 JSONPath subset (`$`, `$.field`, `$.field.nested`,
> `$.items[0]`) in `packages/execution/src/request-outputs.ts` — I4
> backward-compat row passes automatically.
>
> - **I1 GraphQL** — `kind: graphql` request kind with `.gql` file
>   resolution, error-aware extraction.
> - **I2 pagination** — declarative cursor / link-header / offset auto-follow
>   with flattened extracted arrays.
> - **I3 decimal-safe money** — bigint-minor-unit comparator with currency
>   parser and `strict` / `rounded-half-even` modes.
> - **I4 JSONPath extensions** — `[*]` wildcard, `[-1]` negative index,
>   `[0:3]` slices, `[?(@.field == 'ok')]` equality predicate only.
>
> PM/QA pin at B+ on fixture coverage.

**Automated checks (CI / agent-executable):**

- [ ] **I1 GraphQL request.** Create a `kind: request` with a `graphql` block referencing a `.gql` file and variables. Verify the outbound request is `POST` with `Content-Type: application/json` and a body containing `{ "query": "...", "variables": { ... } }`. Verify the query text matches the `.gql` file content exactly.
- [ ] **I1 GraphQL extraction.** Configure a JSONPath assertion on `$.data.organization.repositories.totalCount`. Verify extraction works with the `data.*` convention — no need to manually account for the GraphQL wrapper.
- [ ] **I1 GraphQL error handling.** Send a response with `{ "errors": [...], "data": null }`. Verify the assertion fails with a diagnostic that includes the GraphQL error message, not just "null at path".
- [ ] **I1 tracked `.gql` files.** Verify `.gql` files resolve under `httpi/graphql/` and are treated as tracked definitions.
- [ ] **I2 cursor pagination.** Configure `paginate.kind: cursor` against a fixture that returns 3 pages with a `next_cursor` field. Verify httpi follows all 3 pages, the extracted `items` array is flattened to contain all items from all pages, and exactly 3 HTTP requests are made.
- [ ] **I2 `maxPages` enforcement.** Set `maxPages: 2` on a 5-page fixture. Verify only 2 pages are fetched and the extracted array contains items from pages 1–2 only.
- [ ] **I2 Link header pagination.** Configure `paginate.kind: link-header`. Verify httpi follows `Link: <url>; rel="next"` headers correctly.
- [ ] **I2 offset pagination.** Configure `paginate.kind: offset` with a known total. Verify correct offset/limit parameter progression.
- [ ] **I2 empty page termination.** Verify pagination stops when a page returns an empty array or a null cursor, without requiring `maxPages`.
- [ ] **I3 decimal-safe money — exact match.** Assert `$.amount money: { value: "10.99", currency: usd, mode: strict }` against a response containing `10.99`. Verify pass. Assert against `10.990000001` (float precision artifact); verify it still passes (parsed as minor units: 1099 == 1099).
- [ ] **I3 decimal-safe money — failure.** Assert against `10.98`. Verify fail with a diagnostic showing expected `1099` cents vs actual `1098` cents.
- [ ] **I3 decimal-safe money — `rounded-half-even`.** Assert `mode: rounded-half-even` against `10.985`. Verify it rounds to `10.98` (banker's rounding) and compares correctly.
- [ ] **I3 missing currency.** Omit the `currency` field. Verify a validation diagnostic at load time.
- [ ] **I4 JSONPath `[*]` wildcard.** Extract `$.items[*].id` from a response with 3 items. Verify an array of 3 IDs is returned.
- [ ] **I4 JSONPath `[-1]` negative index.** Extract `$.items[-1]` from a 5-element array. Verify the last element is returned.
- [ ] **I4 JSONPath `[0:3]` slice.** Extract `$.items[0:3]`. Verify elements at indices 0, 1, 2 are returned.
- [ ] **I4 JSONPath filter predicate.** Extract `$.items[?(@.status == 'ok')]`. Verify only items with `status: "ok"` are returned. Verify non-equality predicates (e.g., `> 5`) are rejected with a diagnostic.
- [ ] **I4 JSONPath boundary.** Attempt `$.items[?(@.status.toLowerCase() == 'ok')]`. Verify this is rejected — no function calls allowed in the subset.
- [x] **I4 backward compatibility.** Verify all v0 JSONPath expressions (`$`, `$.field`, `$.field.nested`, `$.items[0]`) still work identically.

**Human review checkpoints:**

- [ ] Review I1 GraphQL query file loading. Confirm `.gql` files are read as raw text and NOT parsed as YAML or processed through the template engine (no `{{}}` substitution inside GraphQL queries — only `variables` handles parameterization).
- [ ] Review I2 pagination implementation for infinite loop protection. Beyond `maxPages`, confirm there is a hardcoded safety limit and that identical consecutive cursors (server bug) are detected and halt pagination.
- [ ] Verify I3 money parsing handles all ISO 4217 currencies with correct minor-unit exponents (e.g., JPY has 0 decimal places, BHD has 3). Confirm the currency table is explicit, not derived from floating-point assumptions.
- [ ] Review I4 JSONPath filter predicate parser. Confirm it accepts ONLY equality predicates (`==`) on string and number literals. No `!=`, no `>`, no `<`, no regex, no function calls. The subset must be explicitly documented and enforced at parse time.
- [ ] Verify I4 does not introduce recursive descent or backtracking that could be exploited for ReDoS-style attacks on crafted JSONPath expressions.

---

### Group J — Governance, compliance, and safety

#### J1. Audit log export with signed manifest

**What.** `httpi export audit <sessionId>` emits a signed JSONL bundle of all requests, responses (redacted), assertions, attempts, and outcomes, suitable for SOC 2 / PCI evidence.

**Why.** P5, P8.

**How.** Derive a manifest hash from the run's compiled snapshot + artifact index. Sign with a local key (or configured KMS) producing `audit.manifest.sig`. The export is reproducible from artifacts.

**Principle check.** Read-only, deterministic, uses existing artifacts.

**Priority.** **P2**.

---

#### J2. Declarative redaction rules

**What.** Let projects declare redaction beyond the current header list: JSONPath masks, regex masks on text, and named PII detectors (email, phone, credit-card).

**Why.** P1, P5, P7, P8.

**How.**

```yaml
# httpi/config.yaml
capture:
  redactHeaders: [authorization, cookie, set-cookie]
  redactJsonPaths:
    - $.user.email
    - $.payment.card_number
  redactPatterns:
    - kind: email
    - kind: us-ssn
    - kind: regex
      pattern: "sk-live-[A-Za-z0-9]+"
```

Applied at capture time, not display time. Same rules feed CLI output, MCP output, and tracked cassette redaction.

**Principle check.** Declarative, closed matcher vocabulary, same engine.

**Priority.** **P0**.

---

#### J3. Pre-commit hook: block secret literals in tracked files

**What.** A lightweight hook (`httpi check secrets`) that scans tracked definitions for likely secret literals and exits non-zero.

**Why.** P5, P6, P8.

**How.** Built on top of J2 patterns. Shipped as an opt-in Husky / lefthook recipe in `scripts/hooks/`.

**Priority.** **P2**.

---

#### Group J — Validation and verification

> **Status (2026-04-12).** Partially landed: **J2 header redaction**
> applies to CLI, MCP, session JSON, and stream artifacts today via
> `redactHeaders`, `redactText`, and the new `redactJsonValue`
> (`packages/shared/src/index.ts`) walker. JSONPath-targeted redaction,
> named PII detectors (email / us-ssn), regex redaction, audit export,
> and pre-commit hook are deferred scope-extension work.
>
> - **J1 audit export + signed manifest** — new `httpi export audit` +
>   SHA-256 manifest + local-key signer, plus verification command.
> - **J2 `redactJsonPaths` + `redactPatterns`** — declared rules fed
>   through a unified capture-time redaction pipeline that covers
>   artifacts, cassettes (G2), reporters (F1), and OTel spans (H1).
> - **J3 `httpi check secrets`** — pre-commit hook scanning tracked
>   files with the same pattern vocabulary as J2.
>
> PM/QA pin at B+ on fixture coverage.

**Automated checks (CI / agent-executable):**

- [ ] **J1 audit export.** Run a session with 3 steps. Export with `httpi export audit <sessionId>`. Verify the output is a valid JSONL file containing one record per request, response, assertion, and attempt — all with redacted values. Verify the file includes a manifest hash line.
- [ ] **J1 manifest signature.** Verify `audit.manifest.sig` is produced alongside the JSONL export. Verify the signature validates against the manifest hash using the configured key.
- [ ] **J1 reproducibility.** Run `httpi export audit <sessionId>` twice. Verify the JSONL content and manifest hash are byte-identical (deterministic).
- [ ] **J1 redaction in export.** Configure redaction rules (J2). Verify the audit export applies all redaction rules — search the JSONL for known secret values and assert zero matches.
- [x] **J2 header redaction.** Configure `redactHeaders: [authorization, cookie]`. Run a request with both headers. Verify artifacts, CLI output, and MCP responses all show `[REDACTED]` for those header values. Verify the original values are NOT stored anywhere on disk.
- [ ] **J2 JSONPath redaction.** Configure `redactJsonPaths: [$.user.email]`. Run a request that returns a body with `user.email`. Verify the email is replaced with `[REDACTED]` in the response artifact. Verify it is also redacted in snapshot files (B3), cassette files (G2), CI reporter output (F1), and OTel span attributes (H1).
- [ ] **J2 pattern redaction — named.** Configure `redactPatterns: [{ kind: email }]`. Verify email addresses in response bodies are redacted even without explicit JSONPath targeting.
- [ ] **J2 pattern redaction — regex.** Configure `redactPatterns: [{ kind: regex, pattern: "sk-live-[A-Za-z0-9]+" }]`. Verify matching strings are redacted in all outputs.
- [ ] **J2 capture-time enforcement.** Verify redaction occurs BEFORE writing to disk. Inspect the raw artifact file bytes (not through the httpi read path) and confirm the redacted value is never present in the file.
- [ ] **J2 uniform application.** For a single redaction rule, verify it applies identically across: CLI terminal output, MCP response JSON, session artifacts (`.httpi/responses/`), cassette files (G2), CI reporter output (F1 JUnit/TAP/GitHub), OTel spans (H1), and audit exports (J1). All must show the same redaction placeholder.
- [ ] **J3 pre-commit hook — secret detected.** Place `sk-live-abc123def456` in a tracked YAML file. Run `httpi check secrets`. Verify exit code 1 and a diagnostic naming the file, line, and matched pattern.
- [ ] **J3 pre-commit hook — clean.** Run `httpi check secrets` on a project with no secret literals. Verify exit code 0.
- [ ] **J3 pattern alignment.** Verify `httpi check secrets` uses the same pattern vocabulary as J2 `redactPatterns`. A pattern configured in J2 must also be detected by J3.
- [ ] **J3 Husky integration.** Verify the shipped hook recipe in `scripts/hooks/` is a valid Husky pre-commit hook that calls `httpi check secrets` and fails the commit on non-zero exit.

**Human review checkpoints:**

- [ ] Review J1 manifest hash computation. Confirm it hashes the compiled snapshot + artifact index deterministically (sorted keys, no floating-point, no timestamps that would vary). Confirm the hash algorithm is SHA-256.
- [ ] Verify J1 audit export cannot be weaponized as an information leak. Confirm the export applies the SAME redaction rules as capture-time redaction — it must not be possible to export unredacted data through the audit path.
- [ ] Review J2 capture-time redaction implementation. Confirm it operates as a write-time filter on the artifact writer, not a read-time filter on artifact display. This is the single most important security property in the redaction system. Trace the code path from `fetch` response to disk write and confirm the redaction transform is in the pipeline.
- [ ] Verify J2 regex patterns are compiled once at load time and applied efficiently. Confirm there are no ReDoS-vulnerable patterns in the built-in named detectors (email, SSN, credit card). Test with adversarial inputs (e.g., long strings of digits) and confirm O(n) behavior.
- [ ] Review J3 for false negatives. Confirm it scans ALL tracked files under `httpi/` (not just `*.yaml`), including block files, dataset files, GraphQL queries, and schema files.
- [ ] Verify the audit signing mechanism is documented and the verification command (`httpi verify audit <export>`) exists or is planned. An audit trail that can't be verified is theater.

---

## 6. Proposed prioritization

### P0 — Next release (unblocks AI adoption and hardens the baseline)

1. A1 — SSE / chunked streaming with per-chunk capture (AI critical)
2. A2 — Long-lived request timeouts and cancellation
3. B1 — Declarative semantic assertions (`expect` DSL)
4. B2 — JSON Schema response validation
5. C1 — Retry + idempotency-key templating
6. C4 — `pollUntil` step
7. D1 — Core auth schemes (bearer, basic, oauth2-client-credentials, oauth2-auth-code local, hmac)
8. D4 — Environment guards for prod
9. E1 — Compact MCP responses + summarization on read
10. E2 — `file:line` structured diagnostics
11. E3 — Mutation gating safe-by-default
12. F1 — CI reporters (JUnit, TAP, GitHub)
13. G1 — Dataset-driven fan-out
14. J2 — Declarative redaction rules

### P1 — Near-term

- A3 — Binary / multipart / streamed downloads
- B3 — Snapshot / golden diffs with JSON Patch output
- C2 — Conditional branching and switch
- C3 — `forEach` loop with bounded concurrency
- C4 — `waitForWebhook` step (receiver half)
- C5 — Sub-run invocation
- C7 — Bounded concurrency on `parallel`
- D1 — AWS SigV4, mTLS, JWT sign/verify
- D2 — Auto token refresh
- D3 — Vault / 1Password / AWS SM resolvers
- D5 — Webhook signature verifier vocabulary
- E4 — Scaffolding (`httpi new ...`)
- E5 — Single-step replay
- E6 — Variable provenance in diagnostics
- F2 — `summary.json` + `summary.md`
- F3 — `httpi diff <sessionA> <sessionB>`
- G2 — Record / replay cassettes
- H1 — OTel trace export
- H2 — Token / cost accounting
- I1 — GraphQL kind
- I2 — Pagination primitives
- I4 — Richer JSONPath subset

### P2 — Medium-term

- B4 — LLM-as-judge assertions
- B5 — Semantic similarity assertions
- B6 — Latency percentile assertions
- C6 — Compensation blocks
- D1 — Device-code, on-behalf-of auth grants
- E7 — `httpi lint`
- G3 — HAR import
- H3 — Chaos injection
- I3 — Decimal-safe money type
- J1 — Audit log with signed manifest
- J3 — Secret literal pre-commit hook

### P3 — Explore

- gRPC as a first-class request kind (after I1 lands)
- WebSocket request kind
- Prometheus scrape endpoint for long-running runs
- Pluggable eval backends beyond `llm-judge`
- VS Code "run this step" lens

---

## 7. Design constraints that must survive every improvement

Every P0–P3 item above was checked against these invariants. Any future proposal that breaks one of them must be rejected outright.

1. **Pure-data YAML.** No embedded scripting, no `eval`, no Lua/JS hooks, no user-supplied predicates. Every new feature expands a closed vocabulary that ships with the engine.
2. **Tracked intent, untracked runtime.** `httpi/` is the source of truth; `.httpi/` holds evidence. A new improvement may add tracked files (snapshots, cassettes, rubrics, datasets, GraphQL queries, schemas) or runtime files (auth caches, judge caches, downloads, telemetry exports), never both in the same place.
3. **Path-derived identity.** File-path is the canonical ID. Titles are cosmetic.
4. **CLI ↔ MCP parity.** Every new command surfaces identically in both adapters with the same diagnostics, same redaction, same artifact semantics.
5. **Explicit, operator-driven recovery.** No auto-retries beyond declared policy; no automatic rollback; no silent resume.
6. **Redaction at capture time.** Applied uniformly to CLI, MCP, session JSON, artifacts, cassettes, and CI reporter output.
7. **Deterministic artifact paths.** New features may add new artifact directories, but paths must remain stable and greppable.
8. **Agents and humans read the same files.** If an improvement benefits only one of them, it is suspect.

---

## 8. Non-goals (reaffirmed)

These remained out-of-scope across every persona signal worth acting on:

- GUI / desktop interface.
- Hosted cloud collaboration layer.
- Turing-complete scripting DSL, pre-request hooks, or post-response hooks.
- Generalized plugin runtime for arbitrary JavaScript.
- Postman / Bruno import as a primary adoption path (HAR import is enough).
- Auto-retry across steps beyond declared policies.
- Implicit secret storage in tracked files.
- Global shared sessions across unrelated runs.

---

## 9. How to consume this document

1. Use §5 as the canonical list of proposals. Each block is self-contained — a contributor can pick one and implement it without cross-referencing the rest.
2. Use §6 to sequence work into releases.
3. Use §7 as the acceptance gate for any PR that claims to implement one of these improvements. If the PR breaks an invariant, reject it regardless of feature value.
4. Revisit the gap analysis in §4 quarterly. Mark rows as closed, and drop any row whose persona signal has shifted.

The shape of httpi does not need to change to absorb most of this proposal. What needs to change is the amount of declarative vocabulary the engine understands. Every improvement above is additive within the existing architectural boundaries — streaming response modes in `packages/http`, new step kinds and expression vocabulary in `packages/execution`, new resolver kinds in `packages/runtime`, new reporters as leaf packages. The invariants hold.
