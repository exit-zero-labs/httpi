import { sep } from "node:path";

export const schemaVersion = 1 as const;
export const redactedValue = "[REDACTED]" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export type FlatVariableValue = JsonPrimitive;
export type FlatVariableMap = Record<string, FlatVariableValue>;

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

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

export interface EnrichedDiagnostic
  extends Omit<Diagnostic, "hint" | "file" | "filePath" | "line" | "column"> {
  hint: string;
  file: string;
  filePath: string;
  line: number;
  column: number;
}

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

export function toDisplayDiagnosticFile(filePath: string): string {
  if (
    filePath === "<unknown>" ||
    filePath === "<input>" ||
    filePath.startsWith("$ENV:")
  ) {
    return filePath;
  }

  const normalizedPath = filePath.split(sep).join("/");
  if (
    normalizedPath.startsWith("httpi/") ||
    normalizedPath.startsWith(".httpi/")
  ) {
    return normalizedPath;
  }

  for (const marker of ["/httpi/", "/.httpi/"]) {
    const markerIndex = normalizedPath.lastIndexOf(marker);
    if (markerIndex !== -1) {
      return normalizedPath.slice(markerIndex + 1);
    }
  }

  return "<unknown>";
}

export interface CapturePolicy {
  requestSummary: boolean;
  responseMetadata: boolean;
  responseBody: "full" | "metadata" | "none";
  maxBodyBytes: number;
  redactHeaders: string[];
}

// --- Redaction rules (J2) ---

export type RedactPatternKind = "email" | "us-ssn" | "credit-card" | "regex";

export interface RedactPattern {
  kind: RedactPatternKind;
  pattern?: string | undefined;
}

export interface RedactionConfig {
  redactHeaders?: string[] | undefined;
  redactJsonPaths?: string[] | undefined;
  redactPatterns?: RedactPattern[] | undefined;
}

// --- Mutation gating (E3) ---

export type MutationGatingMode =
  | "pause-before"
  | "allow"
  | "require-explicit-step";

export interface MutationConfirmation {
  mutating?: MutationGatingMode | undefined;
  overrides?: Array<{ step: string; allow: boolean }> | undefined;
}

// --- CI Reporter (F1) ---

export type ReporterFormat = "junit" | "tap" | "github" | "json";

export interface ProjectConfig {
  schemaVersion: typeof schemaVersion;
  project: string;
  defaultEnv?: string | undefined;
  defaults: FlatVariableMap;
  capture: CapturePolicy;
  redaction?: RedactionConfig | undefined;
}

export interface EnvironmentGuards {
  requireEnv?: string | undefined;
  requireFlag?: string | undefined;
  blockParallelAbove?: number | undefined;
  blockIfBranchNotIn?: string[] | undefined;
  denyHosts?: string[] | undefined;
}

export interface EnvironmentDefinition {
  schemaVersion: typeof schemaVersion;
  title?: string | undefined;
  guards?: EnvironmentGuards | undefined;
  values: FlatVariableMap;
}

export interface HeaderBlockDefinition {
  schemaVersion?: typeof schemaVersion | undefined;
  title?: string | undefined;
  headers: Record<string, string>;
}

export interface BearerAuthDefinition {
  scheme: "bearer";
  token: string;
}

export interface BasicAuthDefinition {
  scheme: "basic";
  username: string;
  password: string;
}

export interface HeaderAuthDefinition {
  scheme: "header";
  header: string;
  value: string;
}

export interface OAuth2ClientCredentialsDefinition {
  scheme: "oauth2-client-credentials";
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string[] | undefined;
  cacheKey?: string | undefined;
}

export interface HmacAuthDefinition {
  scheme: "hmac";
  algorithm: "sha256" | "sha512";
  keyId?: string | undefined;
  secret: string;
  sign: string;
  headers?: Record<string, string> | undefined;
}

export type AuthDefinition =
  | BearerAuthDefinition
  | BasicAuthDefinition
  | HeaderAuthDefinition
  | OAuth2ClientCredentialsDefinition
  | HmacAuthDefinition;

export interface AuthBlockDefinition {
  schemaVersion?: typeof schemaVersion | undefined;
  title?: string | undefined;
  auth: AuthDefinition;
}

export interface BodyFileDefinition {
  file: string;
  contentType?: string | undefined;
}

export interface BodyJsonDefinition {
  json: JsonValue;
  contentType?: string | undefined;
}

export interface BodyTextDefinition {
  text: string;
  contentType?: string | undefined;
}

// --- Binary/multipart body types (A3) ---

export interface BodyBinaryDefinition {
  kind: "binary";
  file: string;
  contentType?: string | undefined;
}

export interface MultipartPart {
  name: string;
  file?: string | undefined;
  json?: JsonValue | undefined;
  text?: string | undefined;
  contentType?: string | undefined;
}

export interface BodyMultipartDefinition {
  kind: "multipart";
  parts: MultipartPart[];
}

export type RequestBodyDefinition =
  | BodyFileDefinition
  | BodyJsonDefinition
  | BodyTextDefinition
  | BodyBinaryDefinition
  | BodyMultipartDefinition;

// --- Streaming types (A1) ---

export type ResponseMode = "buffered" | "stream" | "binary";

export type StreamParseMode = "sse" | "ndjson" | "chunked-json";

export type StreamCaptureMode = "chunks" | "final" | "both";

export interface StreamConfig {
  parse: StreamParseMode;
  capture?: StreamCaptureMode | undefined;
  maxBytes?: number | undefined;
}

export interface StreamAssertions {
  firstChunkWithinMs?: number | undefined;
  maxInterChunkMs?: number | undefined;
  minChunks?: number | undefined;
  finalAssembled?: SchemaAssertionDefinition | undefined;
}

export interface SchemaAssertionDefinition {
  kind: "json-schema";
  schema: string;
  draft?: string | undefined;
}

export interface ResponseConfig {
  mode?: ResponseMode | undefined;
  stream?: StreamConfig | undefined;
  // Binary response (A3)
  saveTo?: string | undefined;
  maxBytes?: number | undefined;
}

// --- Assertion types (B1) ---

export interface LatencyMatcher {
  lt?: number | undefined;
  lte?: number | undefined;
  gt?: number | undefined;
  gte?: number | undefined;
}

export interface HeaderMatcher {
  startsWith?: string | undefined;
  endsWith?: string | undefined;
  equals?: string | undefined;
  contains?: string | undefined;
  matches?: string | undefined;
  exists?: boolean | undefined;
}

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

export interface AssertionResult {
  path: string;
  matcher: string;
  expected: JsonValue;
  actual: JsonValue;
  passed: boolean;
}

export interface RequestExpectation {
  status?: number | number[] | undefined;
  latencyMs?: LatencyMatcher | undefined;
  headers?: Record<string, HeaderMatcher | string> | undefined;
  body?: BodyExpectation | undefined;
  stream?: StreamAssertions | undefined;
}

export interface ExtractionDefinition {
  from: string;
  required?: boolean | undefined;
  secret?: boolean | undefined;
}

export interface RequestUses {
  headers?: string[] | undefined;
  auth?: string | undefined;
}

export interface CancelConfig {
  onRunTimeout?: boolean | undefined;
  onSignal?: string[] | undefined;
}

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

export type BackoffStrategy = "exponential" | "linear" | "constant";
export type JitterStrategy = "full" | "equal" | "none";

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

export interface IdempotencyConfig {
  header: string;
  value: string;
}

// --- PollUntil types (C4) ---

export interface PollUntilCondition {
  jsonPath: string;
  equals?: JsonValue | undefined;
  gte?: number | undefined;
  lte?: number | undefined;
  gt?: number | undefined;
  lt?: number | undefined;
  exists?: boolean | undefined;
}

export interface RunRequestStepDefinition {
  kind: "request";
  id: string;
  uses: string;
  with?: FlatVariableMap | undefined;
  retry?: RetryPolicy | undefined;
  idempotency?: IdempotencyConfig | undefined;
}

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

export interface RunParallelStepDefinition {
  kind: "parallel";
  id: string;
  steps: RunRequestStepDefinition[];
}

export interface RunPauseStepDefinition {
  kind: "pause";
  id: string;
  reason: string;
}

export type RunStepDefinition =
  | RunRequestStepDefinition
  | RunParallelStepDefinition
  | RunPauseStepDefinition
  | RunPollUntilStepDefinition;

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

export type DatasetSourceFormat = "jsonl" | "csv" | "yaml";

export interface RunDatasetStepDefinition {
  kind: "dataset";
  id: string;
  source: string;
  concurrency?: number | undefined;
  steps: RunRequestStepDefinition[];
}

export type DefinitionKind =
  | "config"
  | "env"
  | "header-block"
  | "auth-block"
  | "request"
  | "run";

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

export interface CompiledHeaderBlock {
  id: string;
  filePath: string;
  hash: string;
  headers: Record<string, string>;
}

export interface CompiledAuthBlock {
  id: string;
  filePath: string;
  hash: string;
  auth: AuthDefinition;
}

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

export interface CompiledRequestStep {
  kind: "request";
  id: string;
  requestId: string;
  with: FlatVariableMap;
  request: CompiledRequestDefinition;
  retry?: RetryPolicy | undefined;
  idempotency?: IdempotencyConfig | undefined;
}

export interface CompiledParallelStep {
  kind: "parallel";
  id: string;
  steps: CompiledRequestStep[];
}

export interface CompiledPauseStep {
  kind: "pause";
  id: string;
  reason: string;
}

export interface CompiledPollUntilStep {
  kind: "pollUntil";
  id: string;
  requestStep: CompiledRequestStep;
  until: PollUntilCondition;
  intervalMs: number;
  maxAttempts: number;
  timeoutMs?: number | undefined;
}

export type CompiledRunStep =
  | CompiledRequestStep
  | CompiledParallelStep
  | CompiledPauseStep
  | CompiledPollUntilStep;

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
  createdAt: string;
}

export type SessionState =
  | "created"
  | "running"
  | "paused"
  | "failed"
  | "completed"
  | "interrupted";

export type StepState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "interrupted";

export interface StreamChunkRecord {
  seq: number;
  tOffsetMs: number;
  bytes: number;
  preview: string;
}

export interface StepArtifactSummary {
  requestSummaryPath?: string | undefined;
  responseMetadataPath?: string | undefined;
  bodyPath?: string | undefined;
  streamChunksPath?: string | undefined;
  streamAssembledPath?: string | undefined;
}

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

export interface ArtifactManifestEntry {
  schemaVersion: typeof schemaVersion;
  sessionId: string;
  stepId: string;
  attempt: number;
  kind:
    | "request.summary"
    | "response.meta"
    | "body"
    | "stream.chunks"
    | "stream.assembled";
  relativePath: string;
  contentType?: string | undefined;
  sha256?: string | undefined;
  size?: number | undefined;
}

export interface ArtifactManifest {
  schemaVersion: typeof schemaVersion;
  sessionId: string;
  entries: ArtifactManifestEntry[];
}

export interface ResolvedRequestBody {
  contentType?: string | undefined;
  text?: string | undefined;
  binary?: Uint8Array | undefined;
}

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
}

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
        firstChunkMs?: number | undefined;
        maxInterChunkMs?: number | undefined;
        totalChunks: number;
        totalBytes: number;
      }
    | undefined;
  durationMs: number;
}

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

export interface DefinitionSummary {
  id: string;
  title?: string | undefined;
  filePath: string;
}

export interface SessionSummary {
  sessionId: string;
  runId: string;
  envId: string;
  state: SessionState;
  nextStepId?: string | undefined;
  updatedAt: string;
}

export interface ListDefinitionsResult {
  rootDir: string;
  requests: DefinitionSummary[];
  runs: DefinitionSummary[];
  envs: DefinitionSummary[];
  sessions: SessionSummary[];
  diagnostics: EnrichedDiagnostic[];
}

export interface DescribeRequestResult {
  requestId: string;
  envId: string;
  request: ResolvedRequestModel;
  variables: VariableExplanation[];
  diagnostics: EnrichedDiagnostic[];
}

export interface DescribeRunStep {
  id: string;
  kind: CompiledRunStep["kind"];
  requestId?: string | undefined;
  reason?: string | undefined;
  children?: DescribeRunStep[] | undefined;
}

export interface DescribeRunResult {
  runId: string;
  envId: string;
  title?: string | undefined;
  steps: DescribeRunStep[];
  diagnostics: EnrichedDiagnostic[];
}

export interface ExecutionResult {
  session: SessionRecord;
  diagnostics: EnrichedDiagnostic[];
}

export interface SessionStateResult {
  session: SessionRecord;
  diagnostics: EnrichedDiagnostic[];
}

export interface ArtifactListResult {
  sessionId: string;
  artifacts: ArtifactManifestEntry[];
}

export interface ArtifactReadResult {
  sessionId: string;
  relativePath: string;
  contentType?: string | undefined;
  text?: string | undefined;
  base64?: string | undefined;
}

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
