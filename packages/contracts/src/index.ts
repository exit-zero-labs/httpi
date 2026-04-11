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
  filePath?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  path?: string | undefined;
}

export interface CapturePolicy {
  requestSummary: boolean;
  responseMetadata: boolean;
  responseBody: "full" | "metadata" | "none";
  maxBodyBytes: number;
  redactHeaders: string[];
}

export interface ProjectConfig {
  schemaVersion: typeof schemaVersion;
  project: string;
  defaultEnv?: string | undefined;
  defaults: FlatVariableMap;
  capture: CapturePolicy;
}

export interface EnvironmentDefinition {
  schemaVersion: typeof schemaVersion;
  title?: string | undefined;
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

export type AuthDefinition =
  | BearerAuthDefinition
  | BasicAuthDefinition
  | HeaderAuthDefinition;

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

export type RequestBodyDefinition =
  | BodyFileDefinition
  | BodyJsonDefinition
  | BodyTextDefinition;

export interface RequestExpectation {
  status?: number | number[] | undefined;
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
  expect?: RequestExpectation | undefined;
  extract?: Record<string, ExtractionDefinition> | undefined;
  timeoutMs?: number | undefined;
}

export interface RunRequestStepDefinition {
  kind: "request";
  id: string;
  uses: string;
  with?: FlatVariableMap | undefined;
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
  | RunPauseStepDefinition;

export interface RunDefinition {
  kind: "run";
  title?: string | undefined;
  env?: string | undefined;
  inputs?: FlatVariableMap | undefined;
  steps: RunStepDefinition[];
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
  diagnostics: Diagnostic[];
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
  expect: RequestExpectation;
  extract: Record<string, ExtractionDefinition>;
  timeoutMs?: number | undefined;
}

export interface CompiledRequestStep {
  kind: "request";
  id: string;
  requestId: string;
  with: FlatVariableMap;
  request: CompiledRequestDefinition;
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

export type CompiledRunStep =
  | CompiledRequestStep
  | CompiledParallelStep
  | CompiledPauseStep;

export interface CompiledRunSnapshot {
  schemaVersion: typeof schemaVersion;
  source: "run" | "request";
  runId: string;
  title?: string | undefined;
  envId: string;
  configPath: string;
  configHash: string;
  configDefaults: FlatVariableMap;
  capture: CapturePolicy;
  envPath: string;
  envHash: string;
  envValues: FlatVariableMap;
  runInputs: FlatVariableMap;
  definitionHashes: Record<string, string>;
  steps: CompiledRunStep[];
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

export interface StepArtifactSummary {
  requestSummaryPath?: string | undefined;
  responseMetadataPath?: string | undefined;
  bodyPath?: string | undefined;
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
  kind: "request.summary" | "response.meta" | "body";
  relativePath: string;
  contentType?: string | undefined;
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
  diagnostics: Diagnostic[];
}

export interface DescribeRequestResult {
  requestId: string;
  envId: string;
  request: ResolvedRequestModel;
  variables: VariableExplanation[];
  diagnostics: Diagnostic[];
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
  diagnostics: Diagnostic[];
}

export interface ExecutionResult {
  session: SessionRecord;
  diagnostics: Diagnostic[];
}

export interface SessionStateResult {
  session: SessionRecord;
  diagnostics: Diagnostic[];
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
  diagnostics: Diagnostic[];
}
