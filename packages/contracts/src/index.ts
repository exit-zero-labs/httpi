/**
 * Shared public contracts for the entire repository.
 *
 * Anything that crosses package, CLI, MCP, or on-disk boundaries should be
 * declared here so every surface agrees on shape, terminology, and semantics.
 */
import { sep } from "node:path";

/** Version tag written into tracked and runtime-owned documents. */
export const schemaVersion = 1 as const;
/** Canonical replacement used when secret-bearing values are redacted. */
export const redactedValue = "[REDACTED]" as const;

/** Primitive JSON value accepted in request bodies, assertions, and artifacts. */
export type JsonPrimitive = string | number | boolean | null;
/** Recursive JSON value used across schemas, outputs, and persisted artifacts. */
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

/** Flat scalar used for env values, defaults, overrides, and extracted outputs. */
export type FlatVariableValue = JsonPrimitive;
/** Flat map because precedence and provenance are tracked per scalar key. */
export type FlatVariableMap = Record<string, FlatVariableValue>;

/** HTTP methods supported by request definitions and resolved requests. */
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/** Structured diagnostic surfaced consistently across CLI, MCP, and APIs. */
export interface Diagnostic {
  level: "error" | "warning";
  code: string;
  message: string;
  hint?: string | undefined;
  // Canonical display-safe path surfaced on public interfaces.
  file?: string | undefined;
  // Legacy alias retained for compatibility. Enriched diagnostics keep this in sync with `file`.
  filePath?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  path?: string | undefined;
}

/** Runtime guard for unknown diagnostic-like values. */
export function isDiagnostic(value: unknown): value is Diagnostic {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    (candidate.level === "error" || candidate.level === "warning") &&
    isOptionalString(candidate.hint) &&
    isOptionalString(candidate.file) &&
    isOptionalString(candidate.filePath) &&
    isOptionalNumber(candidate.line) &&
    isOptionalNumber(candidate.column) &&
    isOptionalString(candidate.path)
  );
}

/** Diagnostic with file, line, column, and hint fully populated. */
export interface EnrichedDiagnostic
  extends Omit<Diagnostic, "hint" | "file" | "filePath" | "line" | "column"> {
  hint: string;
  file: string;
  filePath: string;
  line: number;
  column: number;
}

/** Runtime guard for diagnostics that have already been enriched. */
export function isEnrichedDiagnostic(
  value: unknown,
): value is EnrichedDiagnostic {
  if (!isDiagnostic(value)) {
    return false;
  }

  const candidate = value as unknown as Record<string, unknown>;
  return (
    typeof candidate.hint === "string" &&
    typeof candidate.file === "string" &&
    typeof candidate.filePath === "string" &&
    typeof candidate.line === "number" &&
    Number.isFinite(candidate.line) &&
    typeof candidate.column === "number" &&
    Number.isFinite(candidate.column)
  );
}

/** Append a diagnostic path segment using dotted or indexed notation. */
export function appendDiagnosticPath(
  basePath: string,
  segment: string | number,
): string {
  if (!basePath) {
    if (typeof segment === "number") {
      return `[${segment}]`;
    }

    return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)
      ? segment
      : `[${JSON.stringify(segment)}]`;
  }

  if (typeof segment === "number") {
    return `${basePath}[${segment}]`;
  }

  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)) {
    return `${basePath}.${segment}`;
  }

  return `${basePath}[${JSON.stringify(segment)}]`;
}

/** Convert an absolute file path into the stable display path shown to users. */
export function toDisplayDiagnosticFile(filePath: string): string {
  if (
    filePath === "<unknown>" ||
    filePath === "<input>" ||
    filePath.startsWith("$ENV:")
  ) {
    return filePath;
  }

  const normalizedPath = filePath.split(sep).join("/");
  if (normalizedPath.startsWith("httpi/")) {
    return normalizedPath;
  }

  for (const marker of ["/httpi/"]) {
    const markerIndex = normalizedPath.lastIndexOf(marker);
    if (markerIndex !== -1) {
      return normalizedPath.slice(markerIndex + 1);
    }
  }

  return "<unknown>";
}

/** Capture policy compiled from project config and applied to every step attempt. */
export interface CapturePolicy {
  requestSummary: boolean;
  responseMetadata: boolean;
  responseBody: "full" | "metadata" | "none";
  maxBodyBytes: number;
  redactHeaders: string[];
}

// --- Redaction rules (J2) ---

/** Supported built-in redaction strategies for runtime inspection surfaces. */
export type RedactPatternKind = "email" | "us-ssn" | "credit-card" | "regex";

/** Pattern entry used by the project redaction policy. */
export interface RedactPattern {
  kind: RedactPatternKind;
  pattern?: string | undefined;
}

/** Project-wide redaction policy applied to output and artifact reads. */
export interface RedactionConfig {
  redactHeaders?: string[] | undefined;
  redactJsonPaths?: string[] | undefined;
  redactPatterns?: RedactPattern[] | undefined;
}

// --- Mutation gating (E3) ---

/** Policy for how mutating steps must be confirmed before execution. */
export type MutationGatingMode =
  | "pause-before"
  | "allow"
  | "require-explicit-step";

/** Optional run-level confirmation rules for mutating behavior. */
export interface MutationConfirmation {
  mutating?: MutationGatingMode | undefined;
  overrides?: Array<{ step: string; allow: boolean }> | undefined;
}

// --- CI Reporter (F1) ---

/** Reporter output formats exposed by the CLI surface. */
export type ReporterFormat = "junit" | "tap" | "github" | "json";

/** Top-level tracked project config loaded from `httpi/config.yaml`. */
export interface ProjectConfig {
  schemaVersion: typeof schemaVersion;
  project: string;
  defaultEnv?: string | undefined;
  defaults: FlatVariableMap;
  capture: CapturePolicy;
  redaction?: RedactionConfig | undefined;
}

/** Environment-level safety gates evaluated before sensitive execution modes. */
export interface EnvironmentGuards {
  requireEnv?: string | undefined;
  requireFlag?: string | undefined;
  blockParallelAbove?: number | undefined;
  blockIfBranchNotIn?: string[] | undefined;
  denyHosts?: string[] | undefined;
}

/** Tracked non-secret environment values loaded from `httpi/env/*.env.yaml`. */
export interface EnvironmentDefinition {
  schemaVersion: typeof schemaVersion;
  title?: string | undefined;
  guards?: EnvironmentGuards | undefined;
  values: FlatVariableMap;
}

/** Reusable header block referenced by requests through `uses.headers`. */
export interface HeaderBlockDefinition {
  schemaVersion?: typeof schemaVersion | undefined;
  title?: string | undefined;
  headers: Record<string, string>;
}

/** Inline bearer token auth applied directly by a request or auth block. */
export interface BearerAuthDefinition {
  scheme: "bearer";
  token: string;
}

/** Inline HTTP Basic auth credentials. */
export interface BasicAuthDefinition {
  scheme: "basic";
  username: string;
  password: string;
}

/** Generic header-based auth for custom schemes. */
export interface HeaderAuthDefinition {
  scheme: "header";
  header: string;
  value: string;
}

/** Client-credentials OAuth2 flow resolved at execution time. */
export interface OAuth2ClientCredentialsDefinition {
  scheme: "oauth2-client-credentials";
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string[] | undefined;
  cacheKey?: string | undefined;
}

/** Request signing scheme for HMAC-protected APIs. */
export interface HmacAuthDefinition {
  scheme: "hmac";
  algorithm: "sha256" | "sha512";
  keyId?: string | undefined;
  secret: string;
  sign: string;
  headers?: Record<string, string> | undefined;
}

/** All auth shapes supported by the tracked request DSL. */
export type AuthDefinition =
  | BearerAuthDefinition
  | BasicAuthDefinition
  | HeaderAuthDefinition
  | OAuth2ClientCredentialsDefinition
  | HmacAuthDefinition;

/** Reusable auth block referenced by requests through `uses.auth`. */
export interface AuthBlockDefinition {
  schemaVersion?: typeof schemaVersion | undefined;
  title?: string | undefined;
  auth: AuthDefinition;
}

/** File-backed request body loaded relative to the tracked project. */
export interface BodyFileDefinition {
  file: string;
  contentType?: string | undefined;
}

/** Inline JSON request body. */
export interface BodyJsonDefinition {
  json: JsonValue;
  contentType?: string | undefined;
}

/** Inline text request body. */
export interface BodyTextDefinition {
  text: string;
  contentType?: string | undefined;
}

// --- Binary/multipart body types (A3) ---

/** Binary request body read from disk and sent without text coercion. */
export interface BodyBinaryDefinition {
  kind: "binary";
  file: string;
  contentType?: string | undefined;
}

/** One multipart field, with exactly one payload source in practice. */
export interface MultipartPart {
  name: string;
  file?: string | undefined;
  json?: JsonValue | undefined;
  text?: string | undefined;
  contentType?: string | undefined;
}

/** Multipart request body composed from text, JSON, and file parts. */
export interface BodyMultipartDefinition {
  kind: "multipart";
  parts: MultipartPart[];
}

/** Supported request-body authoring forms. */
export type RequestBodyDefinition =
  | BodyFileDefinition
  | BodyJsonDefinition
  | BodyTextDefinition
  | BodyBinaryDefinition
  | BodyMultipartDefinition;

// --- Streaming types (A1) ---

/** Response handling mode selected for a request. */
export type ResponseMode = "buffered" | "stream" | "binary";

/** Streaming parser used when `response.mode` is `stream`. */
export type StreamParseMode = "sse" | "ndjson" | "chunked-json";

/** Which parts of a stream should be persisted for later inspection. */
export type StreamCaptureMode = "chunks" | "final" | "both";

/** Stream parsing and capture settings compiled onto a request. */
export interface StreamConfig {
  parse: StreamParseMode;
  capture?: StreamCaptureMode | undefined;
  maxBytes?: number | undefined;
}

/** Assertions evaluated against streaming timing and assembled output. */
export interface StreamAssertions {
  firstChunkWithinMs?: number | undefined;
  maxInterChunkMs?: number | undefined;
  minChunks?: number | undefined;
  finalAssembled?: SchemaAssertionDefinition | undefined;
}

/** Schema assertion that validates a JSON payload against an external schema file. */
export interface SchemaAssertionDefinition {
  kind: "json-schema";
  schema: string;
  draft?: string | undefined;
}

/** Response handling directives attached to a request definition. */
export interface ResponseConfig {
  mode?: ResponseMode | undefined;
  stream?: StreamConfig | undefined;
  // Binary response (A3)
  saveTo?: string | undefined;
  maxBytes?: number | undefined;
}

// --- Assertion types (B1) ---

/** Numeric matcher used for latency and other scalar thresholds. */
export interface LatencyMatcher {
  lt?: number | undefined;
  lte?: number | undefined;
  gt?: number | undefined;
  gte?: number | undefined;
}

/** Header matcher supporting exact, partial, and regex-based checks. */
export interface HeaderMatcher {
  startsWith?: string | undefined;
  endsWith?: string | undefined;
  equals?: string | undefined;
  contains?: string | undefined;
  matches?: string | undefined;
  exists?: boolean | undefined;
}

/** Small JSONPath assertion DSL used for response-body checks. */
export interface JsonPathAssertion {
  path: string;
  equals?: JsonValue | undefined;
  length?:
    | number
    | { gte?: number; lte?: number; gt?: number; lt?: number }
    | undefined;
  matches?: string | undefined;
  exists?: boolean | undefined;
  gte?: number | undefined;
  lte?: number | undefined;
  gt?: number | undefined;
  lt?: number | undefined;
}

/** Body expectations for text, JSON, schema, and snapshot assertions. */
export interface BodyExpectation {
  contentType?: string | undefined;
  jsonPath?: JsonPathAssertion[] | undefined;
  contains?: string[] | undefined;
  not?:
    | {
        jsonPath?: JsonPathAssertion[] | undefined;
        contains?: string[] | undefined;
      }
    | undefined;
  kind?: "json-schema" | "snapshot" | undefined;
  schema?: string | undefined;
  draft?: string | undefined;
  // Snapshot (B3)
  file?: string | undefined;
  mask?: Array<{ path: string }> | undefined;
}

/** Machine-readable result for one individual assertion evaluation. */
export interface AssertionResult {
  path: string;
  matcher: string;
  expected: JsonValue;
  actual: JsonValue;
  passed: boolean;
}

/** Iterate a request step multiple times with optional concurrency. */
export interface IterateConfig {
  count: number;
  concurrency?: number | undefined;
}

/** Percentile thresholds used for aggregate latency expectations. */
export interface PercentileMatcher {
  p50?: LatencyMatcher | undefined;
  p95?: LatencyMatcher | undefined;
  p99?: LatencyMatcher | undefined;
}

/** Aggregate expectations evaluated across an iterated request step. */
export interface AggregateExpectation {
  latencyMs?: PercentileMatcher | undefined;
  errorRate?: LatencyMatcher | undefined;
}

/** All built-in expectations that can be attached to a request. */
export interface RequestExpectation {
  status?: number | number[] | undefined;
  latencyMs?: LatencyMatcher | undefined;
  headers?: Record<string, HeaderMatcher | string> | undefined;
  body?: BodyExpectation | undefined;
  stream?: StreamAssertions | undefined;
  aggregate?: AggregateExpectation | undefined;
}

/** Extraction rule that promotes part of a response into step outputs. */
export interface ExtractionDefinition {
  from: string;
  required?: boolean | undefined;
  secret?: boolean | undefined;
}

/** References to reusable tracked blocks consumed by a request. */
export interface RequestUses {
  headers?: string[] | undefined;
  auth?: string | undefined;
}

/** Cancellation behavior requested for a step or run invocation. */
export interface CancelConfig {
  onRunTimeout?: boolean | undefined;
  onSignal?: string[] | undefined;
}

/** Atomic request definition loaded from `httpi/requests/<path>.request.yaml`. */
export interface RequestDefinition {
  kind: "request";
  title?: string | undefined;
  method: HttpMethod;
  url: string;
  uses?: RequestUses | undefined;
  defaults?: FlatVariableMap | undefined;
  headers?: Record<string, string> | undefined;
  auth?: AuthDefinition | undefined;
  body?: RequestBodyDefinition | undefined;
  response?: ResponseConfig | undefined;
  expect?: RequestExpectation | undefined;
  extract?: Record<string, ExtractionDefinition> | undefined;
  timeoutMs?: number | undefined;
  cancel?: CancelConfig | undefined;
}

// --- Retry types (C1) ---

/** Backoff curve used by step retry behavior. */
export type BackoffStrategy = "exponential" | "linear" | "constant";
/** Jitter strategy applied to calculated retry delays. */
export type JitterStrategy = "full" | "equal" | "none";

/** Retry policy applied to a request step inside a run. */
export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  backoff?: BackoffStrategy | undefined;
  jitter?: JitterStrategy | undefined;
  retryOn?:
    | {
        status?: number[] | undefined;
        errorClass?: string[] | undefined;
      }
    | undefined;
}

/** Idempotency header emitted on retried request steps when configured. */
export interface IdempotencyConfig {
  header: string;
  value: string;
}

// --- PollUntil types (C4) ---

/** Poll condition evaluated against the latest response body. */
export interface PollUntilCondition {
  jsonPath: string;
  equals?: JsonValue | undefined;
  gte?: number | undefined;
  lte?: number | undefined;
  gt?: number | undefined;
  lt?: number | undefined;
  exists?: boolean | undefined;
}

/** Standard request step inside a run graph. */
export interface RunRequestStepDefinition {
  kind: "request";
  id: string;
  uses: string;
  with?: FlatVariableMap | undefined;
  retry?: RetryPolicy | undefined;
  idempotency?: IdempotencyConfig | undefined;
  iterate?: IterateConfig | undefined;
}

/** Polling step that repeatedly issues a request until a condition is met. */
export interface RunPollUntilStepDefinition {
  kind: "pollUntil";
  id: string;
  request: {
    uses: string;
    with?: FlatVariableMap | undefined;
  };
  until: PollUntilCondition;
  intervalMs: number;
  maxAttempts?: number | undefined;
  timeoutMs?: number | undefined;
}

/** Parallel fan-out step whose children are all request steps. */
export interface RunParallelStepDefinition {
  kind: "parallel";
  id: string;
  concurrency?: number | undefined;
  steps: RunRequestStepDefinition[];
}

/** Explicit pause point that persists the session before the next step starts. */
export interface RunPauseStepDefinition {
  kind: "pause";
  id: string;
  reason: string;
}

// C2 switch step — closed DSL, no user code.
export interface SwitchExpression {
  /**
   * A dotted reference into run context. Supported forms:
   *   steps.<id>.response.status
   *   steps.<id>.response.headers["x-foo"]
   *   steps.<id>.extracted.<name>
   */
  ref: string;
}

export interface SwitchCase {
  when: JsonValue | JsonValue[];
  steps: RunRequestStepDefinition[];
}

/** Declarative branch step driven by a previously produced runtime value. */
export interface RunSwitchStepDefinition {
  kind: "switch";
  id: string;
  on: string;
  cases: SwitchCase[];
  default?: { steps: RunRequestStepDefinition[] } | undefined;
}

/** All top-level step kinds currently supported by the run DSL. */
export type RunStepDefinition =
  | RunRequestStepDefinition
  | RunParallelStepDefinition
  | RunPauseStepDefinition
  | RunPollUntilStepDefinition
  | RunSwitchStepDefinition;

/** Multi-step workflow definition loaded from `httpi/runs/<path>.run.yaml`. */
export interface RunDefinition {
  kind: "run";
  title?: string | undefined;
  env?: string | undefined;
  inputs?: FlatVariableMap | undefined;
  steps: RunStepDefinition[];
  timeoutMs?: number | undefined;
  defaults?: { timeoutMs?: number | undefined } | undefined;
  confirmation?: MutationConfirmation | undefined;
}

// --- Dataset fan-out types (G1) ---

/** Supported tracked dataset formats for future fan-out style workflows. */
export type DatasetSourceFormat = "jsonl" | "csv" | "yaml";

/** Dataset-driven fan-out step shape reserved by the contracts package. */
export interface RunDatasetStepDefinition {
  kind: "dataset";
  id: string;
  source: string;
  concurrency?: number | undefined;
  steps: RunRequestStepDefinition[];
}

/** Kinds of tracked definitions discovered in the project tree. */
export type DefinitionKind =
  | "config"
  | "env"
  | "header-block"
  | "auth-block"
  | "request"
  | "run";

/** Typed tracked file with path-derived identity and content hash. */
export interface LoadedDefinition<TDefinition> {
  kind: DefinitionKind;
  id: string;
  title?: string | undefined;
  filePath: string;
  hash: string;
  definition: TDefinition;
}

export type EnvironmentFile = LoadedDefinition<EnvironmentDefinition>;
export type HeaderBlockFile = LoadedDefinition<HeaderBlockDefinition>;
export type AuthBlockFile = LoadedDefinition<AuthBlockDefinition>;
export type RequestFile = LoadedDefinition<RequestDefinition>;
export type RunFile = LoadedDefinition<RunDefinition>;

/** Fully loaded tracked project state ready for validation or compilation. */
export interface ProjectFiles {
  rootDir: string;
  configPath: string;
  configHash: string;
  config: ProjectConfig;
  environments: Record<string, EnvironmentFile>;
  headerBlocks: Record<string, HeaderBlockFile>;
  authBlocks: Record<string, AuthBlockFile>;
  requests: Record<string, RequestFile>;
  runs: Record<string, RunFile>;
  diagnostics: EnrichedDiagnostic[];
}

/** Header block after compilation has resolved path identity and hash. */
export interface CompiledHeaderBlock {
  id: string;
  filePath: string;
  hash: string;
  headers: Record<string, string>;
}

/** Auth block after compilation has resolved path identity and hash. */
export interface CompiledAuthBlock {
  id: string;
  filePath: string;
  hash: string;
  auth: AuthDefinition;
}

/** Fully merged request definition used by the execution layer. */
export interface CompiledRequestDefinition {
  requestId: string;
  title?: string | undefined;
  filePath: string;
  hash: string;
  method: HttpMethod;
  url: string;
  defaults: FlatVariableMap;
  headers: Record<string, string>;
  headerBlocks: CompiledHeaderBlock[];
  auth?: AuthDefinition | undefined;
  authBlock?: CompiledAuthBlock | undefined;
  body?: RequestBodyDefinition | undefined;
  response?: ResponseConfig | undefined;
  expect: RequestExpectation;
  extract: Record<string, ExtractionDefinition>;
  timeoutMs?: number | undefined;
  cancel?: CancelConfig | undefined;
}

/** Request step after its referenced request has been compiled and inlined. */
export interface CompiledRequestStep {
  kind: "request";
  id: string;
  requestId: string;
  with: FlatVariableMap;
  request: CompiledRequestDefinition;
  retry?: RetryPolicy | undefined;
  idempotency?: IdempotencyConfig | undefined;
  iterate?: IterateConfig | undefined;
}

/** Parallel step after each child request step has been compiled. */
export interface CompiledParallelStep {
  kind: "parallel";
  id: string;
  concurrency?: number | undefined;
  steps: CompiledRequestStep[];
}

/** Pause step after compilation; no further transformation is required. */
export interface CompiledPauseStep {
  kind: "pause";
  id: string;
  reason: string;
}

/** Polling step after its request and timing rules have been normalized. */
export interface CompiledPollUntilStep {
  kind: "pollUntil";
  id: string;
  requestStep: CompiledRequestStep;
  until: PollUntilCondition;
  intervalMs: number;
  maxAttempts: number;
  timeoutMs?: number | undefined;
}

export interface CompiledSwitchCase {
  when: JsonValue | JsonValue[];
  steps: CompiledRequestStep[];
}

/** Switch step after each branch has been compiled to request steps. */
export interface CompiledSwitchStep {
  kind: "switch";
  id: string;
  on: string;
  cases: CompiledSwitchCase[];
  defaultSteps?: CompiledRequestStep[] | undefined;
}

/** Normalized executable step kinds produced by snapshot compilation. */
export type CompiledRunStep =
  | CompiledRequestStep
  | CompiledParallelStep
  | CompiledPauseStep
  | CompiledPollUntilStep
  | CompiledSwitchStep;

/**
 * Immutable execution snapshot created at run start.
 *
 * Resume safety depends on this object: tracked definitions, env values, and
 * non-secret inputs are frozen here, while runtime-only secrets are resolved
 * later when a step is materialized.
 */
export interface CompiledRunSnapshot {
  schemaVersion: typeof schemaVersion;
  source: "run" | "request";
  runId: string;
  title?: string | undefined;
  sourceFilePath?: string | undefined;
  envId: string;
  configPath: string;
  configHash: string;
  configDefaults: FlatVariableMap;
  capture: CapturePolicy;
  envPath: string;
  envHash: string;
  envValues: FlatVariableMap;
  runInputs: FlatVariableMap;
  overrideKeys?: string[] | undefined;
  processEnvHashes?: Record<string, string> | undefined;
  definitionHashes: Record<string, string>;
  steps: CompiledRunStep[];
  envGuards?: EnvironmentGuards | undefined;
  runTimeoutMs?: number | undefined;
  createdAt: string;
}

/** Top-level session states persisted under `httpi/artifacts/sessions/`. */
export type SessionState =
  | "created"
  | "running"
  | "paused"
  | "failed"
  | "completed"
  | "interrupted";

/** Per-step states persisted inside the session record. */
export type StepState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "interrupted";

/** Captured summary for one parsed streaming event or chunk. */
export interface StreamChunkRecord {
  seq: number;
  tOffsetMs: number;
  bytes: number;
  preview: string;
}

/** Redacted request body captured inside the canonical per-attempt request record. */
export interface RequestArtifactRequestBody {
  bytes: number;
  contentType?: string | undefined;
  text?: string | undefined;
  base64?: string | undefined;
}

/** Fully materialized request captured for one attempt. */
export interface RequestArtifactRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  bodyBytes: number;
  timeoutMs: number;
  responseMode?: ResponseMode | undefined;
  responseMaxBytes?: number | undefined;
  saveTo?: string | undefined;
  streamConfig?: StreamConfig | undefined;
  body?: RequestArtifactRequestBody | undefined;
}

/** Recorded response metadata captured for one attempt, even when incomplete. */
export interface RequestArtifactResponse {
  received: boolean;
  status?: number | undefined;
  statusText?: string | undefined;
  headers?: Record<string, string> | undefined;
  bodyText?: string | undefined;
  bodyBase64?: string | undefined;
  bodyBytes?: number | undefined;
  contentType?: string | undefined;
  truncated?: boolean | undefined;
}

/** Error metadata captured alongside a failed request attempt. */
export interface RequestArtifactError {
  message: string;
  code?: string | undefined;
  class?: string | undefined;
}

/** Canonical per-attempt request artifact written under `history/<sessionId>/`. */
export interface RequestArtifactRecord {
  schemaVersion: typeof schemaVersion;
  sessionId: string;
  stepId: string;
  attempt: number;
  requestId: string;
  outcome: "success" | "failed";
  durationMs?: number | undefined;
  request: RequestArtifactRequest;
  response: RequestArtifactResponse;
  error?: RequestArtifactError | undefined;
  stream?:
    | {
        chunks: StreamChunkRecord[];
        assembledText?: string | undefined;
        assembledJson?: JsonValue | undefined;
        assembledLast?: JsonValue | undefined;
        firstChunkMs?: number | undefined;
        maxInterChunkMs?: number | undefined;
        totalChunks: number;
        totalBytes: number;
      }
    | undefined;
  binary?:
    | {
        absolutePath: string;
        relativePath: string;
        bytes: number;
        sha256: string;
        truncated: boolean;
      }
    | undefined;
}

/** Relative artifact paths recorded for one completed attempt. */
export interface StepArtifactSummary {
  requestPath?: string | undefined;
  bodyPath?: string | undefined;
  streamChunksPath?: string | undefined;
  streamAssembledPath?: string | undefined;
  binaryPath?: string | undefined;
  binarySha256?: string | undefined;
  binaryBytes?: number | undefined;
}

/** Immutable record of one attempt at executing a step. */
export interface StepAttemptRecord {
  attempt: number;
  startedAt: string;
  finishedAt?: string | undefined;
  durationMs?: number | undefined;
  outcome: "success" | "failed" | "paused" | "interrupted";
  statusCode?: number | undefined;
  errorMessage?: string | undefined;
  artifacts?: StepArtifactSummary | undefined;
}

/** Per-step execution ledger nested inside the persisted session. */
export interface SessionStepRecord {
  stepId: string;
  kind: CompiledRunStep["kind"];
  requestId?: string | undefined;
  state: StepState;
  attempts: StepAttemptRecord[];
  output: Record<string, FlatVariableValue>;
  secretOutputKeys?: string[] | undefined;
  errorMessage?: string | undefined;
  childStepIds?: string[] | undefined;
}

/**
 * Persisted runtime session.
 *
 * This is the operator-facing source of truth for inspection, pause/resume,
 * step attempts, extracted outputs, and artifact lookup.
 */
export interface SessionRecord {
  schemaVersion: typeof schemaVersion;
  sessionId: string;
  source: "run" | "request";
  runId: string;
  envId: string;
  state: SessionState;
  nextStepId?: string | undefined;
  compiled: CompiledRunSnapshot;
  stepRecords: Record<string, SessionStepRecord>;
  stepOutputs: Record<string, Record<string, FlatVariableValue>>;
  artifactManifestPath: string;
  eventLogPath: string;
  createdAt: string;
  updatedAt: string;
  pausedReason?: string | undefined;
  failureReason?: string | undefined;
  resumedFromSessionId?: string | undefined;
}

/** Structured lifecycle event appended to `events.jsonl` during execution. */
export interface SessionEvent {
  schemaVersion: typeof schemaVersion;
  eventType: string;
  timestamp: string;
  sessionId: string;
  runId: string;
  stepId?: string | undefined;
  attempt?: number | undefined;
  durationMs?: number | undefined;
  outcome?: string | undefined;
  errorClass?: string | undefined;
  artifactPath?: string | undefined;
  message?: string | undefined;
}

/** One manifest row describing a captured artifact for later inspection. */
export interface ArtifactManifestEntry {
  schemaVersion: typeof schemaVersion;
  sessionId: string;
  stepId: string;
  attempt: number;
  kind:
    | "request"
    | "body"
    | "stream.chunks"
    | "stream.assembled"
    | "response.binary";
  relativePath: string;
  contentType?: string | undefined;
  sha256?: string | undefined;
  size?: number | undefined;
  sizeBytes?: number | undefined;
}

/** Manifest written alongside session artifacts under `httpi/artifacts/history/`. */
export interface ArtifactManifest {
  schemaVersion: typeof schemaVersion;
  sessionId: string;
  entries: ArtifactManifestEntry[];
}

/** Concrete request body after files/templates have been resolved. */
export interface ResolvedRequestBody {
  contentType?: string | undefined;
  text?: string | undefined;
  binary?: Uint8Array | undefined;
}

/** Fully materialized HTTP request ready for transport execution. */
export interface ResolvedRequestModel {
  requestId: string;
  stepId: string;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: ResolvedRequestBody | undefined;
  timeoutMs: number;
  secretValues: string[];
  responseMode?: ResponseMode | undefined;
  streamConfig?: StreamConfig | undefined;
  // Binary response (A3): where to write the downloaded file and the upper
  // byte limit. Paths are relative to the project root and enforced to stay
  // within `httpi/artifacts/` by the executor.
  saveTo?: string | undefined;
  responseMaxBytes?: number | undefined;
}

/** Streaming callbacks used by the execution layer for live event emission. */
export interface StreamEventHooks {
  onFirstByte?: (info: { tOffsetMs: number }) => void;
  onChunk?: (chunk: StreamChunkRecord) => void;
  onCompleted?: (info: {
    totalChunks: number;
    totalBytes: number;
    durationMs: number;
  }) => void;
  onFailed?: (info: { errorClass: string; message: string }) => void;
}

/** HTTP execution hooks for cancellation and stream observation. */
export interface HttpExecutionHooks {
  shouldCancel?: () => boolean | Promise<boolean>;
  stream?: StreamEventHooks;
}

/** Result shape returned by the HTTP transport package. */
export interface HttpExecutionResult {
  request: {
    method: HttpMethod;
    url: string;
    headers: Record<string, string>;
    bodyBytes: number;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyText?: string | undefined;
    bodyBase64?: string | undefined;
    bodyBytes: number;
    contentType?: string | undefined;
    truncated: boolean;
  };
  stream?:
    | {
        chunks: StreamChunkRecord[];
        assembledText?: string | undefined;
        assembledJson?: JsonValue | undefined;
        // A1 (AI use case): the last parsed event's JSON value, convenient for
        // validating the terminal frame of an SSE/NDJSON stream against
        // `expect.stream.finalAssembled` without having to index into the
        // full array. Undefined if no event parsed as JSON.
        assembledLast?: JsonValue | undefined;
        firstChunkMs?: number | undefined;
        maxInterChunkMs?: number | undefined;
        totalChunks: number;
        totalBytes: number;
      }
    | undefined;
  binary?:
    | {
        absolutePath: string;
        relativePath: string;
        bytes: number;
        sha256: string;
        truncated: boolean;
      }
    | undefined;
  durationMs: number;
}

/** Captured transport state surfaced when HTTP execution fails mid-attempt. */
export interface HttpExecutionCapture {
  request: HttpExecutionResult["request"];
  response?: HttpExecutionResult["response"] | undefined;
  stream?: HttpExecutionResult["stream"] | undefined;
  binary?: HttpExecutionResult["binary"] | undefined;
  durationMs?: number | undefined;
}

/** Provenance record for one effective variable value. */
export interface VariableExplanation {
  name: string;
  value?: FlatVariableValue | undefined;
  source:
    | "override"
    | "step"
    | "run"
    | "request"
    | "env"
    | "config"
    | "secret"
    | "process-env";
  secret?: boolean | undefined;
}

/** Small listing entry returned by discovery surfaces. */
export interface DefinitionSummary {
  id: string;
  title?: string | undefined;
  filePath: string;
}

/** Runtime session summary returned by discovery surfaces. */
export interface SessionSummary {
  sessionId: string;
  runId: string;
  envId: string;
  state: SessionState;
  nextStepId?: string | undefined;
  updatedAt: string;
}

/** Output returned by project discovery commands and tools. */
export interface ListDefinitionsResult {
  rootDir: string;
  requests: DefinitionSummary[];
  runs: DefinitionSummary[];
  envs: DefinitionSummary[];
  sessions: SessionSummary[];
  diagnostics: EnrichedDiagnostic[];
}

/** Explain-one-request result used by CLI and MCP describe surfaces. */
export interface DescribeRequestResult {
  requestId: string;
  envId: string;
  request: ResolvedRequestModel;
  variables: VariableExplanation[];
  diagnostics: EnrichedDiagnostic[];
}

/** Simplified step tree returned by run description commands and tools. */
export interface DescribeRunStep {
  id: string;
  kind: CompiledRunStep["kind"];
  requestId?: string | undefined;
  reason?: string | undefined;
  children?: DescribeRunStep[] | undefined;
}

/** Describe-one-run result returned by CLI and MCP surfaces. */
export interface DescribeRunResult {
  runId: string;
  envId: string;
  title?: string | undefined;
  steps: DescribeRunStep[];
  diagnostics: EnrichedDiagnostic[];
}

/** Standard result returned by run, resume, and execute flows. */
export interface ExecutionResult {
  session: SessionRecord;
  diagnostics: EnrichedDiagnostic[];
}

/** Session inspection result returned by CLI and MCP state queries. */
export interface SessionStateResult {
  session: SessionRecord;
  diagnostics: EnrichedDiagnostic[];
}

/** Artifact listing result for a session or one step. */
export interface ArtifactListResult {
  sessionId: string;
  artifacts: ArtifactManifestEntry[];
}

/** Artifact read result with either text or base64 content. */
export interface ArtifactReadResult {
  sessionId: string;
  relativePath: string;
  contentType?: string | undefined;
  text?: string | undefined;
  base64?: string | undefined;
}

/** Variable provenance result for a request or one run step. */
export interface ExplainVariablesResult {
  targetId: string;
  envId: string;
  variables: VariableExplanation[];
  diagnostics: EnrichedDiagnostic[];
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}
