import { dirname, resolve } from "node:path";
import { LineCounter, parseDocument } from "yaml";
import { schemaVersion } from "@exit-zero-labs/httpi-contracts";
import type {
  AuthBlockDefinition,
  AuthDefinition,
  CapturePolicy,
  CompiledAuthBlock,
  CompiledHeaderBlock,
  CompiledPauseStep,
  CompiledRequestDefinition,
  CompiledRequestStep,
  CompiledRunSnapshot,
  CompiledRunStep,
  Diagnostic,
  EnvironmentDefinition,
  EnvironmentFile,
  FlatVariableMap,
  FlatVariableValue,
  HeaderBlockDefinition,
  HttpMethod,
  JsonValue,
  LoadedDefinition,
  ProjectConfig,
  ProjectFiles,
  RequestBodyDefinition,
  RequestDefinition,
  RequestExpectation,
  RequestFile,
  RequestUses,
  RunDefinition,
  RunFile,
  RunParallelStepDefinition,
  RunPauseStepDefinition,
  RunRequestStepDefinition,
  RunStepDefinition,
} from "@exit-zero-labs/httpi-contracts";
import {
  HttpiError,
  asRecord,
  envFileSuffix,
  exitCodes,
  fileExists,
  looksLikeSecretFieldName,
  readUtf8File,
  relativeId,
  requestFileSuffix,
  resolveFromRoot,
  runFileSuffix,
  sanitizeFileSegment,
  sha256Hex,
  toIsoTimestamp,
  trackedDirectoryName,
  walkFiles,
  yamlFileSuffix,
} from "@exit-zero-labs/httpi-shared";

const defaultCapturePolicy: CapturePolicy = {
  requestSummary: true,
  responseMetadata: true,
  responseBody: "full",
  maxBodyBytes: 1024 * 1024,
  redactHeaders: ["authorization", "cookie", "set-cookie"],
};

const supportedMethods = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export interface FindProjectRootOptions {
  cwd?: string | undefined;
  projectRoot?: string | undefined;
}

export interface CompileSnapshotOptions {
  envId?: string | undefined;
  overrides?: FlatVariableMap | undefined;
  stepId?: string | undefined;
}

export async function findProjectRoot(
  options: FindProjectRootOptions = {},
): Promise<string> {
  if (options.projectRoot) {
    const resolvedProjectRoot = resolve(options.projectRoot);
    const configPath = resolveFromRoot(
      resolvedProjectRoot,
      trackedDirectoryName,
      "config.yaml",
    );
    if (!(await fileExists(configPath))) {
      throw new HttpiError(
        "PROJECT_NOT_FOUND",
        `No ${trackedDirectoryName}/config.yaml found under ${resolvedProjectRoot}.`,
        {
          exitCode: exitCodes.validationFailure,
        },
      );
    }

    return resolvedProjectRoot;
  }

  const startingDirectory = resolve(options.cwd ?? process.cwd());
  const gitRoot = await findGitRoot(startingDirectory);

  let currentDirectory = startingDirectory;
  while (true) {
    const configPath = resolveFromRoot(
      currentDirectory,
      trackedDirectoryName,
      "config.yaml",
    );
    if (await fileExists(configPath)) {
      return currentDirectory;
    }

    if (currentDirectory === gitRoot) {
      break;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  throw new HttpiError(
    "PROJECT_NOT_FOUND",
    `No ${trackedDirectoryName}/config.yaml found from ${startingDirectory}. Run httpi init first.`,
    {
      exitCode: exitCodes.validationFailure,
    },
  );
}

export async function loadProjectFiles(projectRoot: string): Promise<ProjectFiles> {
  const trackedRoot = resolveFromRoot(projectRoot, trackedDirectoryName);
  const configPath = resolveFromRoot(trackedRoot, "config.yaml");
  const diagnostics: Diagnostic[] = [];

  const parsedConfig = await parseTypedYamlFile(
    configPath,
    "config",
    parseProjectConfig,
  );
  diagnostics.push(...parsedConfig.diagnostics);

  const environments = await loadDefinitionDirectory<EnvironmentDefinition>(
    resolveFromRoot(trackedRoot, "env"),
    "env",
    envFileSuffix,
    parseEnvironmentDefinition,
  );
  diagnostics.push(...environments.diagnostics);

  const headerBlocks = await loadDefinitionDirectory<HeaderBlockDefinition>(
    resolveFromRoot(trackedRoot, "blocks", "headers"),
    "header-block",
    yamlFileSuffix,
    parseHeaderBlockDefinition,
  );
  diagnostics.push(...headerBlocks.diagnostics);

  const authBlocks = await loadDefinitionDirectory<AuthBlockDefinition>(
    resolveFromRoot(trackedRoot, "blocks", "auth"),
    "auth-block",
    yamlFileSuffix,
    parseAuthBlockDefinition,
  );
  diagnostics.push(...authBlocks.diagnostics);

  const requests = await loadDefinitionDirectory<RequestDefinition>(
    resolveFromRoot(trackedRoot, "requests"),
    "request",
    requestFileSuffix,
    parseRequestDefinition,
  );
  diagnostics.push(...requests.diagnostics);

  const runs = await loadDefinitionDirectory<RunDefinition>(
    resolveFromRoot(trackedRoot, "runs"),
    "run",
    runFileSuffix,
    parseRunDefinition,
  );
  diagnostics.push(...runs.diagnostics);

  const config =
    parsedConfig.value ??
    createFallbackProjectConfig(resolve(projectRoot, trackedDirectoryName));
  const configHash = parsedConfig.hash ?? "";

  const projectFiles: ProjectFiles = {
    rootDir: resolve(projectRoot),
    configPath,
    configHash,
    config,
    environments: environments.files,
    headerBlocks: headerBlocks.files,
    authBlocks: authBlocks.files,
    requests: requests.files,
    runs: runs.files,
    diagnostics,
  };

  projectFiles.diagnostics.push(...validateProjectReferences(projectFiles));
  return projectFiles;
}

export function assertProjectIsValid(project: ProjectFiles): void {
  const errors = project.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  if (errors.length === 0) {
    return;
  }

  throw new HttpiError(
    "PROJECT_INVALID",
    "Project definitions contain validation errors.",
    {
      exitCode: exitCodes.validationFailure,
      details: errors,
    },
  );
}

export function compileRunSnapshot(
  project: ProjectFiles,
  runId: string,
  options: CompileSnapshotOptions = {},
): CompiledRunSnapshot {
  assertProjectIsValid(project);

  const runFile = project.runs[runId];
  if (!runFile) {
    throw new HttpiError(
      "RUN_NOT_FOUND",
      `Run ${runId} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const envFile = resolveEnvironmentFile(project, options.envId ?? runFile.definition.env);
  const runInputs = {
    ...(runFile.definition.inputs ?? {}),
    ...(options.overrides ?? {}),
  };

  const definitionHashes: Record<string, string> = {
    [project.configPath]: project.configHash,
    [envFile.filePath]: envFile.hash,
    [runFile.filePath]: runFile.hash,
  };

  const compiledSteps = compileRunSteps(project, runFile.definition.steps, definitionHashes);

  return {
    schemaVersion,
    source: "run",
    runId,
    title: runFile.title,
    envId: envFile.id,
    configPath: project.configPath,
    configHash: project.configHash,
    configDefaults: project.config.defaults,
    capture: project.config.capture,
    envPath: envFile.filePath,
    envHash: envFile.hash,
    envValues: envFile.definition.values,
    runInputs,
    definitionHashes,
    steps: compiledSteps,
    createdAt: toIsoTimestamp(),
  };
}

export function compileRequestSnapshot(
  project: ProjectFiles,
  requestId: string,
  options: CompileSnapshotOptions = {},
): CompiledRunSnapshot {
  assertProjectIsValid(project);

  const requestFile = project.requests[requestId];
  if (!requestFile) {
    throw new HttpiError(
      "REQUEST_NOT_FOUND",
      `Request ${requestId} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  const envFile = resolveEnvironmentFile(project, options.envId);
  const definitionHashes: Record<string, string> = {
    [project.configPath]: project.configHash,
    [envFile.filePath]: envFile.hash,
    [requestFile.filePath]: requestFile.hash,
  };

  const compiledRequest = compileRequestDefinition(project, requestFile, definitionHashes);
  const stepId = options.stepId ?? "request";
  const step: CompiledRequestStep = {
    kind: "request",
    id: stepId,
    requestId,
    with: options.overrides ?? {},
    request: compiledRequest,
  };

  return {
    schemaVersion,
    source: "request",
    runId: requestId,
    title: requestFile.title,
    envId: envFile.id,
    configPath: project.configPath,
    configHash: project.configHash,
    configDefaults: project.config.defaults,
    capture: project.config.capture,
    envPath: envFile.filePath,
    envHash: envFile.hash,
    envValues: envFile.definition.values,
    runInputs: options.overrides ?? {},
    definitionHashes,
    steps: [step],
    createdAt: toIsoTimestamp(),
  };
}

function compileRunSteps(
  project: ProjectFiles,
  steps: RunStepDefinition[],
  definitionHashes: Record<string, string>,
): CompiledRunStep[] {
  return steps.map((step) => {
    if (step.kind === "pause") {
      const compiledPauseStep: CompiledPauseStep = {
        kind: "pause",
        id: step.id,
        reason: step.reason,
      };
      return compiledPauseStep;
    }

    if (step.kind === "parallel") {
      return {
        kind: "parallel",
        id: step.id,
        steps: step.steps.map((childStep) =>
          compileRunRequestStep(project, childStep, definitionHashes),
        ),
      };
    }

    return compileRunRequestStep(project, step, definitionHashes);
  });
}

function compileRunRequestStep(
  project: ProjectFiles,
  step: RunRequestStepDefinition,
  definitionHashes: Record<string, string>,
): CompiledRequestStep {
  const requestFile = project.requests[step.uses];
  if (!requestFile) {
    throw new HttpiError(
      "REQUEST_NOT_FOUND",
      `Request ${step.uses} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  return {
    kind: "request",
    id: step.id,
    requestId: requestFile.id,
    with: step.with ?? {},
    request: compileRequestDefinition(project, requestFile, definitionHashes),
  };
}

function compileRequestDefinition(
  project: ProjectFiles,
  requestFile: RequestFile,
  definitionHashes: Record<string, string>,
): CompiledRequestDefinition {
  const headerBlocks = (requestFile.definition.uses?.headers ?? []).map(
    (headerBlockId) => {
      const headerBlock = project.headerBlocks[headerBlockId];
      if (!headerBlock) {
        throw new HttpiError(
          "HEADER_BLOCK_NOT_FOUND",
          `Header block ${headerBlockId} was not found.`,
          { exitCode: exitCodes.validationFailure },
        );
      }

      definitionHashes[headerBlock.filePath] = headerBlock.hash;
      const compiledHeaderBlock: CompiledHeaderBlock = {
        id: headerBlock.id,
        filePath: headerBlock.filePath,
        hash: headerBlock.hash,
        headers: headerBlock.definition.headers,
      };
      return compiledHeaderBlock;
    },
  );

  let authBlock: CompiledAuthBlock | undefined;
  if (requestFile.definition.uses?.auth) {
    const authBlockFile = project.authBlocks[requestFile.definition.uses.auth];
    if (!authBlockFile) {
      throw new HttpiError(
        "AUTH_BLOCK_NOT_FOUND",
        `Auth block ${requestFile.definition.uses.auth} was not found.`,
        { exitCode: exitCodes.validationFailure },
      );
    }

    definitionHashes[authBlockFile.filePath] = authBlockFile.hash;
    authBlock = {
      id: authBlockFile.id,
      filePath: authBlockFile.filePath,
      hash: authBlockFile.hash,
      auth: authBlockFile.definition.auth,
    };
  }

  definitionHashes[requestFile.filePath] = requestFile.hash;

  return {
    requestId: requestFile.id,
    title: requestFile.title,
    filePath: requestFile.filePath,
    hash: requestFile.hash,
    method: requestFile.definition.method,
    url: requestFile.definition.url,
    defaults: requestFile.definition.defaults ?? {},
    headers: requestFile.definition.headers ?? {},
    headerBlocks,
    auth: requestFile.definition.auth,
    authBlock,
    body: requestFile.definition.body,
    expect: requestFile.definition.expect ?? {},
    extract: requestFile.definition.extract ?? {},
    timeoutMs: requestFile.definition.timeoutMs,
  };
}

function resolveEnvironmentFile(
  project: ProjectFiles,
  requestedEnvId: string | undefined,
): EnvironmentFile {
  const envId = requestedEnvId ?? project.config.defaultEnv;
  if (!envId) {
    throw new HttpiError(
      "ENV_NOT_SPECIFIED",
      "No environment was provided and the project has no defaultEnv.",
      { exitCode: exitCodes.validationFailure },
    );
  }

  const envFile = project.environments[envId];
  if (!envFile) {
    throw new HttpiError(
      "ENV_NOT_FOUND",
      `Environment ${envId} was not found.`,
      { exitCode: exitCodes.validationFailure },
    );
  }

  return envFile;
}

async function findGitRoot(startingDirectory: string): Promise<string> {
  let currentDirectory = startingDirectory;
  let latestGitRoot = currentDirectory;

  while (true) {
    if (await fileExists(resolveFromRoot(currentDirectory, ".git"))) {
      latestGitRoot = currentDirectory;
      break;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  return latestGitRoot;
}

async function loadDefinitionDirectory<TDefinition>(
  directoryPath: string,
  kind: LoadedDefinition<TDefinition>["kind"],
  suffix: string,
  parser: (
    value: unknown,
    filePath: string,
  ) => {
    value?: TDefinition;
    diagnostics: Diagnostic[];
    title?: string | undefined;
  },
): Promise<{
  files: Record<string, LoadedDefinition<TDefinition>>;
  diagnostics: Diagnostic[];
}> {
  if (!(await fileExists(directoryPath))) {
    return {
      files: {},
      diagnostics: [],
    };
  }

  const filePaths = (await walkFiles(directoryPath)).filter((filePath) =>
    filePath.endsWith(suffix),
  );

  const diagnostics: Diagnostic[] = [];
  const files: Record<string, LoadedDefinition<TDefinition>> = {};

  for (const filePath of filePaths) {
    const parsedFile = await parseTypedYamlFile(filePath, kind, parser);
    diagnostics.push(...parsedFile.diagnostics);
    if (!parsedFile.value || !parsedFile.hash) {
      continue;
    }

    const id = relativeId(filePath, directoryPath, suffix);
    files[id] = {
      kind,
      id,
      title: parsedFile.title,
      filePath,
      hash: parsedFile.hash,
      definition: parsedFile.value,
    };
  }

  return {
    files,
    diagnostics,
  };
}

async function parseTypedYamlFile<TValue>(
  filePath: string,
  kind: LoadedDefinition<TValue>["kind"],
  parser: (
    value: unknown,
    filePath: string,
  ) => {
    value?: TValue;
    diagnostics: Diagnostic[];
    title?: string | undefined;
  },
): Promise<{
  value?: TValue | undefined;
  diagnostics: Diagnostic[];
  hash?: string | undefined;
  title?: string | undefined;
}> {
  const rawContent = await readUtf8File(filePath);
  const lineCounter = new LineCounter();
  const document = parseDocument(rawContent, {
    lineCounter,
    prettyErrors: false,
  });

  const diagnostics: Diagnostic[] = [];
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const position =
        typeof error.pos?.[0] === "number"
          ? lineCounter.linePos(error.pos[0])
          : undefined;
      diagnostics.push({
        level: "error",
        code: "YAML_PARSE_ERROR",
        message: error.message,
        filePath,
        line: position?.line,
        column: position?.col,
      });
    }

    return { diagnostics };
  }

  const result = parser(document.toJS(), filePath);
  result.diagnostics.push(...detectSecretLiteralDiagnostics(document.toJS(), filePath, kind));

  return {
    value: result.value,
    diagnostics: result.diagnostics,
    hash: sha256Hex(rawContent),
    title: result.title,
  };
}

function createFallbackProjectConfig(projectRoot: string): ProjectConfig {
  return {
    schemaVersion,
    project: projectRoot,
    defaults: {},
    capture: defaultCapturePolicy,
  };
}

function parseProjectConfig(
  value: unknown,
  filePath: string,
): {
  value?: ProjectConfig;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "config");
  if (!record) {
    return { diagnostics };
  }

  const parsedSchemaVersion = readSchemaVersion(record, filePath, diagnostics);
  const project = readRequiredString(
    record,
    "project",
    filePath,
    diagnostics,
    "Project config requires a string project name.",
  );
  const defaultEnv = readOptionalString(record, "defaultEnv", filePath, diagnostics);
  const defaults = readFlatVariableMap(
    record.defaults,
    filePath,
    diagnostics,
    "defaults",
  );
  const capture = normalizeCapturePolicy(record.capture, filePath, diagnostics);

  if (!parsedSchemaVersion || !project) {
    return { diagnostics };
  }

  return {
    value: {
      schemaVersion: parsedSchemaVersion,
      project,
      defaultEnv,
      defaults,
      capture,
    },
    diagnostics,
  };
}

function parseEnvironmentDefinition(
  value: unknown,
  filePath: string,
): {
  value?: EnvironmentDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "environment");
  if (!record) {
    return { diagnostics };
  }

  const parsedSchemaVersion = readSchemaVersion(record, filePath, diagnostics);
  const title = readOptionalString(record, "title", filePath, diagnostics);
  const values = readFlatVariableMap(record.values, filePath, diagnostics, "values");

  if (!parsedSchemaVersion) {
    return { diagnostics };
  }

  return {
    value: {
      schemaVersion: parsedSchemaVersion,
      title,
      values,
    },
    diagnostics,
    title,
  };
}

function parseHeaderBlockDefinition(
  value: unknown,
  filePath: string,
): {
  value?: HeaderBlockDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "header block");
  if (!record) {
    return { diagnostics };
  }

  const title = readOptionalString(record, "title", filePath, diagnostics);
  const parsedSchemaVersion = readOptionalSchemaVersion(record, filePath, diagnostics);
  const headers = readStringMap(record.headers, filePath, diagnostics, "headers");

  return {
    value: {
      schemaVersion: parsedSchemaVersion,
      title,
      headers,
    },
    diagnostics,
    title,
  };
}

function parseAuthBlockDefinition(
  value: unknown,
  filePath: string,
): {
  value?: AuthBlockDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "auth block");
  if (!record) {
    return { diagnostics };
  }

  const title = readOptionalString(record, "title", filePath, diagnostics);
  const parsedSchemaVersion = readOptionalSchemaVersion(record, filePath, diagnostics);
  const auth = parseAuthDefinition(record.auth, filePath, diagnostics, "auth");
  if (!auth) {
    return { diagnostics };
  }

  return {
    value: {
      schemaVersion: parsedSchemaVersion,
      title,
      auth,
    },
    diagnostics,
    title,
  };
}

function parseRequestDefinition(
  value: unknown,
  filePath: string,
): {
  value?: RequestDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "request");
  if (!record) {
    return { diagnostics };
  }

  const kind = readLiteral(
    record,
    "kind",
    "request",
    filePath,
    diagnostics,
  );
  const title = readOptionalString(record, "title", filePath, diagnostics);
  const method = readHttpMethod(record, filePath, diagnostics);
  const url = readRequiredString(
    record,
    "url",
    filePath,
    diagnostics,
    "Request definitions require a string url.",
  );
  const uses = parseRequestUses(record.uses, filePath, diagnostics);
  const defaults = readOptionalFlatVariableMap(
    record.defaults,
    filePath,
    diagnostics,
    "defaults",
  );
  const headers = readOptionalStringMap(record.headers, filePath, diagnostics, "headers");
  const auth = parseOptionalAuthDefinition(record.auth, filePath, diagnostics, "auth");
  const body = parseOptionalBodyDefinition(record.body, filePath, diagnostics);
  const expect = parseOptionalExpect(record.expect, filePath, diagnostics);
  const extract = parseOptionalExtract(record.extract, filePath, diagnostics);
  const timeoutMs = readOptionalNumber(record, "timeoutMs", filePath, diagnostics);

  if (!kind || !method || !url) {
    return { diagnostics };
  }

  if (auth && uses?.auth) {
    diagnostics.push({
      level: "error",
      code: "AUTH_CONFLICT",
      message: "Requests may define inline auth or uses.auth, but not both.",
      filePath,
      path: "auth",
    });
  }

  const requestDefinition: RequestDefinition = {
    kind,
    title,
    method,
    url,
    uses,
    defaults,
    headers,
    auth,
    body,
    expect,
    extract,
    timeoutMs,
  };

  return {
    value: requestDefinition,
    diagnostics,
    title,
  };
}

function parseRunDefinition(
  value: unknown,
  filePath: string,
): {
  value?: RunDefinition;
  diagnostics: Diagnostic[];
  title?: string | undefined;
} {
  const diagnostics: Diagnostic[] = [];
  const record = expectRecord(value, filePath, diagnostics, "run");
  if (!record) {
    return { diagnostics };
  }

  const kind = readLiteral(record, "kind", "run", filePath, diagnostics);
  const title = readOptionalString(record, "title", filePath, diagnostics);
  const env = readOptionalString(record, "env", filePath, diagnostics);
  const inputs = readOptionalFlatVariableMap(
    record.inputs,
    filePath,
    diagnostics,
    "inputs",
  );
  const steps = parseRunSteps(record.steps, filePath, diagnostics);

  if (!kind) {
    return { diagnostics };
  }

  return {
    value: {
      kind,
      title,
      env,
      inputs,
      steps,
    },
    diagnostics,
    title,
  };
}

function validateProjectReferences(project: ProjectFiles): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (
    project.config.defaultEnv &&
    !project.environments[project.config.defaultEnv]
  ) {
    diagnostics.push({
      level: "error",
      code: "DEFAULT_ENV_NOT_FOUND",
      message: `defaultEnv ${project.config.defaultEnv} does not exist.`,
      filePath: project.configPath,
      path: "defaultEnv",
    });
  }

  for (const requestFile of Object.values(project.requests)) {
    for (const headerBlockId of requestFile.definition.uses?.headers ?? []) {
      if (!project.headerBlocks[headerBlockId]) {
        diagnostics.push({
          level: "error",
          code: "HEADER_BLOCK_NOT_FOUND",
          message: `Header block ${headerBlockId} referenced by request ${requestFile.id} does not exist.`,
          filePath: requestFile.filePath,
          path: "uses.headers",
        });
      }
    }

    if (
      requestFile.definition.uses?.auth &&
      !project.authBlocks[requestFile.definition.uses.auth]
    ) {
      diagnostics.push({
        level: "error",
        code: "AUTH_BLOCK_NOT_FOUND",
        message: `Auth block ${requestFile.definition.uses.auth} referenced by request ${requestFile.id} does not exist.`,
        filePath: requestFile.filePath,
        path: "uses.auth",
      });
    }
  }

  for (const runFile of Object.values(project.runs)) {
    if (runFile.definition.env && !project.environments[runFile.definition.env]) {
      diagnostics.push({
        level: "error",
        code: "RUN_ENV_NOT_FOUND",
        message: `Run ${runFile.id} references environment ${runFile.definition.env}, which does not exist.`,
        filePath: runFile.filePath,
        path: "env",
      });
    }

    const stepIds = new Set<string>();
    const sanitizedStepIds = new Map<string, string>();
    validateRunSteps(
      project,
      runFile,
      runFile.definition.steps,
      diagnostics,
      stepIds,
      sanitizedStepIds,
    );
  }

  return diagnostics;
}

function validateRunSteps(
  project: ProjectFiles,
  runFile: RunFile,
  steps: RunStepDefinition[],
  diagnostics: Diagnostic[],
  stepIds: Set<string>,
  sanitizedStepIds: Map<string, string>,
): void {
  for (const step of steps) {
    if (stepIds.has(step.id)) {
      diagnostics.push({
        level: "error",
        code: "DUPLICATE_STEP_ID",
        message: `Run ${runFile.id} contains duplicate step id ${step.id}.`,
        filePath: runFile.filePath,
        path: `steps.${step.id}`,
      });
      continue;
    }

    stepIds.add(step.id);
    validateArtifactSafeStepId(
      runFile,
      step.id,
      diagnostics,
      sanitizedStepIds,
      `steps.${step.id}`,
    );

    if (step.kind === "request") {
      if (!project.requests[step.uses]) {
        diagnostics.push({
          level: "error",
          code: "REQUEST_NOT_FOUND",
          message: `Step ${step.id} references request ${step.uses}, which does not exist.`,
          filePath: runFile.filePath,
          path: `steps.${step.id}.uses`,
        });
      }
      continue;
    }

    if (step.kind === "parallel") {
      for (const childStep of step.steps) {
        if (stepIds.has(childStep.id)) {
          diagnostics.push({
            level: "error",
            code: "DUPLICATE_STEP_ID",
            message: `Run ${runFile.id} contains duplicate step id ${childStep.id}.`,
            filePath: runFile.filePath,
            path: `steps.${step.id}.steps.${childStep.id}`,
          });
          continue;
        }

        stepIds.add(childStep.id);
        validateArtifactSafeStepId(
          runFile,
          childStep.id,
          diagnostics,
          sanitizedStepIds,
          `steps.${step.id}.steps.${childStep.id}`,
        );
        if (!project.requests[childStep.uses]) {
          diagnostics.push({
            level: "error",
            code: "REQUEST_NOT_FOUND",
            message: `Parallel child step ${childStep.id} references request ${childStep.uses}, which does not exist.`,
            filePath: runFile.filePath,
            path: `steps.${step.id}.steps.${childStep.id}.uses`,
          });
        }
      }
    }
  }
}

function validateArtifactSafeStepId(
  runFile: RunFile,
  stepId: string,
  diagnostics: Diagnostic[],
  sanitizedStepIds: Map<string, string>,
  path: string,
): void {
  const sanitizedStepId = sanitizeFileSegment(stepId);
  const existingStepId = sanitizedStepIds.get(sanitizedStepId);
  if (existingStepId && existingStepId !== stepId) {
    diagnostics.push({
      level: "error",
      code: "STEP_ID_PATH_COLLISION",
      message: `Run ${runFile.id} contains step ids ${existingStepId} and ${stepId}, which both sanitize to ${sanitizedStepId} for artifact paths.`,
      filePath: runFile.filePath,
      path,
    });
    return;
  }

  sanitizedStepIds.set(sanitizedStepId, stepId);
}

function parseRunSteps(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RunStepDefinition[] {
  if (!Array.isArray(value)) {
    diagnostics.push({
      level: "error",
      code: "INVALID_STEPS",
      message: "Run definitions require a steps array.",
      filePath,
      path: "steps",
    });
    return [];
  }

  return value.reduce<RunStepDefinition[]>((steps, entry, index) => {
    const stepRecord = asRecord(entry);
    if (!stepRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_STEP",
        message: "Each step must be an object.",
        filePath,
        path: `steps[${index}]`,
      });
      return steps;
    }

    const kind = readRequiredString(
      stepRecord,
      "kind",
      filePath,
      diagnostics,
      "Each step requires a string kind.",
    );
    if (!kind) {
      return steps;
    }

    if (kind === "request") {
      const requestStep = parseRunRequestStep(stepRecord, filePath, diagnostics);
      if (requestStep) {
        steps.push(requestStep);
      }
      return steps;
    }

    if (kind === "pause") {
      const pauseStep = parseRunPauseStep(stepRecord, filePath, diagnostics);
      if (pauseStep) {
        steps.push(pauseStep);
      }
      return steps;
    }

    if (kind === "parallel") {
      const parallelStep = parseRunParallelStep(stepRecord, filePath, diagnostics);
      if (parallelStep) {
        steps.push(parallelStep);
      }
      return steps;
    }

    diagnostics.push({
      level: "error",
      code: "INVALID_STEP_KIND",
      message: `Unsupported run step kind ${kind}.`,
      filePath,
      path: `steps[${index}].kind`,
    });
    return steps;
  }, []);
}

function parseRunRequestStep(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): RunRequestStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "Request steps require a string id.",
  );
  const uses = readRequiredString(
    record,
    "uses",
    filePath,
    diagnostics,
    "Request steps require a string uses reference.",
  );
  const withValues = readOptionalFlatVariableMap(
    record.with,
    filePath,
    diagnostics,
    "with",
  );

  if (!id || !uses) {
    return undefined;
  }

  return {
    kind: "request",
    id,
    uses,
    with: withValues,
  };
}

function parseRunPauseStep(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): RunPauseStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "Pause steps require a string id.",
  );
  const reason = readRequiredString(
    record,
    "reason",
    filePath,
    diagnostics,
    "Pause steps require a string reason.",
  );

  if (!id || !reason) {
    return undefined;
  }

  return {
    kind: "pause",
    id,
    reason,
  };
}

function parseRunParallelStep(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): RunParallelStepDefinition | undefined {
  const id = readRequiredString(
    record,
    "id",
    filePath,
    diagnostics,
    "Parallel steps require a string id.",
  );
  const stepsValue = record.steps;
  if (!Array.isArray(stepsValue)) {
    diagnostics.push({
      level: "error",
      code: "INVALID_PARALLEL_STEPS",
      message: "Parallel steps require a steps array.",
      filePath,
      path: "steps",
    });
    return undefined;
  }

  const steps = stepsValue.flatMap((entry, index) => {
    const childRecord = asRecord(entry);
    if (!childRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_STEP",
        message: "Parallel child steps must be objects.",
        filePath,
        path: `steps.${id}.steps[${index}]`,
      });
      return [];
    }

    const kind = readRequiredString(
      childRecord,
      "kind",
      filePath,
      diagnostics,
      "Parallel child steps require a string kind.",
    );
    if (kind !== "request") {
      diagnostics.push({
        level: "error",
        code: "INVALID_PARALLEL_CHILD_KIND",
        message: "Only request steps are allowed inside parallel groups in v0.",
        filePath,
        path: `steps.${id}.steps[${index}].kind`,
      });
      return [];
    }

    const requestStep = parseRunRequestStep(childRecord, filePath, diagnostics);
    return requestStep ? [requestStep] : [];
  });

  if (!id) {
    return undefined;
  }

  return {
    kind: "parallel",
    id,
    steps,
  };
}

function parseRequestUses(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestUses | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_REQUEST_USES",
      message: "uses must be an object when present.",
      filePath,
      path: "uses",
    });
    return undefined;
  }

  const headersValue = record.headers;
  let headers: string[] | undefined;
  if (headersValue !== undefined) {
    if (!Array.isArray(headersValue) || headersValue.some((entry) => typeof entry !== "string")) {
      diagnostics.push({
        level: "error",
        code: "INVALID_HEADER_REFERENCES",
        message: "uses.headers must be an array of strings.",
        filePath,
        path: "uses.headers",
      });
    } else {
      headers = headersValue;
    }
  }

  const auth = readOptionalString(record, "auth", filePath, diagnostics);
  return {
    headers,
    auth,
  };
}

function parseOptionalExpect(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestExpectation | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_EXPECT",
      message: "expect must be an object when present.",
      filePath,
      path: "expect",
    });
    return undefined;
  }

  const status = record.status;
  if (status === undefined) {
    return {};
  }

  if (typeof status === "number") {
    return { status };
  }

  if (Array.isArray(status) && status.every((entry) => typeof entry === "number")) {
    return { status };
  }

  diagnostics.push({
    level: "error",
    code: "INVALID_EXPECT_STATUS",
    message: "expect.status must be a number or array of numbers.",
    filePath,
    path: "expect.status",
  });
  return undefined;
}

function parseOptionalExtract(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestDefinition["extract"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_EXTRACT",
      message: "extract must be an object when present.",
      filePath,
      path: "extract",
    });
    return undefined;
  }

  const extractEntries: NonNullable<RequestDefinition["extract"]> = {};
  for (const [key, extractValue] of Object.entries(record)) {
    const extractRecord = asRecord(extractValue);
    if (!extractRecord) {
      diagnostics.push({
        level: "error",
        code: "INVALID_EXTRACT_ENTRY",
        message: `extract.${key} must be an object.`,
        filePath,
        path: `extract.${key}`,
      });
      continue;
    }

    const from = readRequiredString(
      extractRecord,
      "from",
      filePath,
      diagnostics,
      `extract.${key}.from must be a string.`,
    );
    const required = readOptionalBoolean(
      extractRecord,
      "required",
      filePath,
      diagnostics,
    );
    const secret = readOptionalBoolean(
      extractRecord,
      "secret",
      filePath,
      diagnostics,
    );
    if (!from) {
      continue;
    }

    extractEntries[key] = {
      from,
      required,
      secret,
    };
  }

  return extractEntries;
}

function parseOptionalBodyDefinition(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): RequestBodyDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_BODY",
      message: "body must be an object when present.",
      filePath,
      path: "body",
    });
    return undefined;
  }

  const contentType = readOptionalString(record, "contentType", filePath, diagnostics);
  if ("file" in record) {
    const file = readRequiredString(
      record,
      "file",
      filePath,
      diagnostics,
      "body.file must be a string.",
    );
    if (!file) {
      return undefined;
    }

    return { file, contentType };
  }

  if ("json" in record) {
    const json = record.json;
    if (!isJsonValue(json)) {
      diagnostics.push({
        level: "error",
        code: "INVALID_JSON_BODY",
        message: "body.json must be valid JSON data.",
        filePath,
        path: "body.json",
      });
      return undefined;
    }

    return { json, contentType };
  }

  if ("text" in record) {
    const text = readRequiredString(
      record,
      "text",
      filePath,
      diagnostics,
      "body.text must be a string.",
    );
    if (!text) {
      return undefined;
    }

    return { text, contentType };
  }

  diagnostics.push({
    level: "error",
    code: "INVALID_BODY_KIND",
    message: "body must define one of file, json, or text.",
    filePath,
    path: "body",
  });
  return undefined;
}

function parseOptionalAuthDefinition(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): AuthDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseAuthDefinition(value, filePath, diagnostics, path);
}

function parseAuthDefinition(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): AuthDefinition | undefined {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_AUTH",
      message: `${path} must be an object.`,
      filePath,
      path,
    });
    return undefined;
  }

  const scheme = readRequiredString(
    record,
    "scheme",
    filePath,
    diagnostics,
    `${path}.scheme must be a string.`,
  );
  if (!scheme) {
    return undefined;
  }

  if (scheme === "bearer") {
    const token = readRequiredString(
      record,
      "token",
      filePath,
      diagnostics,
      `${path}.token must be a string.`,
    );
    if (!token) {
      return undefined;
    }

    return { scheme, token };
  }

  if (scheme === "basic") {
    const username = readRequiredString(
      record,
      "username",
      filePath,
      diagnostics,
      `${path}.username must be a string.`,
    );
    const password = readRequiredString(
      record,
      "password",
      filePath,
      diagnostics,
      `${path}.password must be a string.`,
    );
    if (!username || !password) {
      return undefined;
    }

    return {
      scheme,
      username,
      password,
    };
  }

  if (scheme === "header") {
    const header = readRequiredString(
      record,
      "header",
      filePath,
      diagnostics,
      `${path}.header must be a string.`,
    );
    const authValue = readRequiredString(
      record,
      "value",
      filePath,
      diagnostics,
      `${path}.value must be a string.`,
    );
    if (!header || !authValue) {
      return undefined;
    }

    return {
      scheme,
      header,
      value: authValue,
    };
  }

  diagnostics.push({
    level: "error",
    code: "INVALID_AUTH_SCHEME",
    message: `${path}.scheme must be one of bearer, basic, or header.`,
    filePath,
    path: `${path}.scheme`,
  });
  return undefined;
}

function readSchemaVersion(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): typeof schemaVersion | undefined {
  const rawValue = record.schemaVersion;
  if (rawValue !== schemaVersion) {
    diagnostics.push({
      level: "error",
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `schemaVersion must be ${schemaVersion}.`,
      filePath,
      path: "schemaVersion",
    });
    return undefined;
  }

  return schemaVersion;
}

function readOptionalSchemaVersion(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): typeof schemaVersion | undefined {
  if (record.schemaVersion === undefined) {
    return undefined;
  }

  if (record.schemaVersion !== schemaVersion) {
    diagnostics.push({
      level: "error",
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `schemaVersion must be ${schemaVersion}.`,
      filePath,
      path: "schemaVersion",
    });
    return undefined;
  }

  return schemaVersion;
}

function normalizeCapturePolicy(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
): CapturePolicy {
  if (value === undefined) {
    return defaultCapturePolicy;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_CAPTURE",
      message: "capture must be an object when present.",
      filePath,
      path: "capture",
    });
    return defaultCapturePolicy;
  }

  const requestSummary =
    readOptionalBoolean(record, "requestSummary", filePath, diagnostics) ??
    defaultCapturePolicy.requestSummary;
  const responseMetadata =
    readOptionalBoolean(record, "responseMetadata", filePath, diagnostics) ??
    defaultCapturePolicy.responseMetadata;

  let responseBody = defaultCapturePolicy.responseBody;
  if (record.responseBody !== undefined) {
    if (
      record.responseBody === "full" ||
      record.responseBody === "metadata" ||
      record.responseBody === "none"
    ) {
      responseBody = record.responseBody;
    } else {
      diagnostics.push({
        level: "error",
        code: "INVALID_RESPONSE_BODY_POLICY",
        message: "capture.responseBody must be full, metadata, or none.",
        filePath,
        path: "capture.responseBody",
      });
    }
  }

  const maxBodyBytes =
    readOptionalNumber(record, "maxBodyBytes", filePath, diagnostics) ??
    defaultCapturePolicy.maxBodyBytes;

  const redactHeadersValue = record.redactHeaders;
  let redactHeaders = defaultCapturePolicy.redactHeaders;
  if (redactHeadersValue !== undefined) {
    if (
      Array.isArray(redactHeadersValue) &&
      redactHeadersValue.every((entry) => typeof entry === "string")
    ) {
      redactHeaders = redactHeadersValue;
    } else {
      diagnostics.push({
        level: "error",
        code: "INVALID_REDACT_HEADERS",
        message: "capture.redactHeaders must be an array of strings.",
        filePath,
        path: "capture.redactHeaders",
      });
    }
  }

  return {
    requestSummary,
    responseMetadata,
    responseBody,
    maxBodyBytes,
    redactHeaders,
  };
}

function readHttpMethod(
  record: Record<string, unknown>,
  filePath: string,
  diagnostics: Diagnostic[],
): HttpMethod | undefined {
  const rawMethod = readRequiredString(
    record,
    "method",
    filePath,
    diagnostics,
    "Request definitions require a string method.",
  );
  if (!rawMethod) {
    return undefined;
  }

  const normalizedMethod = rawMethod.toUpperCase();
  if (!supportedMethods.has(normalizedMethod as HttpMethod)) {
    diagnostics.push({
      level: "error",
      code: "INVALID_HTTP_METHOD",
      message: `Unsupported HTTP method ${rawMethod}.`,
      filePath,
      path: "method",
    });
    return undefined;
  }

  return normalizedMethod as HttpMethod;
}

function expectRecord(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  label: string,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_FILE_SHAPE",
      message: `${label} definitions must be objects.`,
      filePath,
    });
  }

  return record;
}

function readLiteral<TValue extends string>(
  record: Record<string, unknown>,
  key: string,
  expectedValue: TValue,
  filePath: string,
  diagnostics: Diagnostic[],
): TValue | undefined {
  if (record[key] !== expectedValue) {
    diagnostics.push({
      level: "error",
      code: "INVALID_LITERAL",
      message: `${key} must be ${expectedValue}.`,
      filePath,
      path: key,
    });
    return undefined;
  }

  return expectedValue;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  diagnostics: Diagnostic[],
  message: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    diagnostics.push({
      level: "error",
      code: "INVALID_STRING",
      message,
      filePath,
      path: key,
    });
    return undefined;
  }

  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  diagnostics: Diagnostic[],
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    diagnostics.push({
      level: "error",
      code: "INVALID_STRING",
      message: `${key} must be a string when present.`,
      filePath,
      path: key,
    });
    return undefined;
  }

  return value;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  diagnostics: Diagnostic[],
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    diagnostics.push({
      level: "error",
      code: "INVALID_BOOLEAN",
      message: `${key} must be a boolean when present.`,
      filePath,
      path: key,
    });
    return undefined;
  }

  return value;
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  filePath: string,
  diagnostics: Diagnostic[],
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    diagnostics.push({
      level: "error",
      code: "INVALID_NUMBER",
      message: `${key} must be a number when present.`,
      filePath,
      path: key,
    });
    return undefined;
  }

  return value;
}

function readFlatVariableMap(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): FlatVariableMap {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_VARIABLE_MAP",
      message: `${path} must be an object with primitive values.`,
      filePath,
      path,
    });
    return {};
  }

  return Object.entries(record).reduce<FlatVariableMap>((result, [key, entry]) => {
    if (isFlatVariableValue(entry)) {
      result[key] = entry;
      return result;
    }

    diagnostics.push({
      level: "error",
      code: "INVALID_VARIABLE_VALUE",
      message: `${path}.${key} must be a string, number, boolean, or null.`,
      filePath,
      path: `${path}.${key}`,
    });
    return result;
  }, {});
}

function readOptionalFlatVariableMap(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): FlatVariableMap | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readFlatVariableMap(value, filePath, diagnostics, path);
}

function readStringMap(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      level: "error",
      code: "INVALID_STRING_MAP",
      message: `${path} must be an object with string values.`,
      filePath,
      path,
    });
    return {};
  }

  return Object.entries(record).reduce<Record<string, string>>((result, [key, entry]) => {
    if (typeof entry === "string") {
      result[key] = entry;
      return result;
    }

    diagnostics.push({
      level: "error",
      code: "INVALID_STRING_MAP_VALUE",
      message: `${path}.${key} must be a string.`,
      filePath,
      path: `${path}.${key}`,
    });
    return result;
  }, {});
}

function readOptionalStringMap(
  value: unknown,
  filePath: string,
  diagnostics: Diagnostic[],
  path: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readStringMap(value, filePath, diagnostics, path);
}

function isFlatVariableValue(value: unknown): value is FlatVariableValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isFlatVariableValue(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return Object.values(record).every((entry) => isJsonValue(entry));
}

function detectSecretLiteralDiagnostics(
  value: unknown,
  filePath: string,
  kind: LoadedDefinition<unknown>["kind"],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  visitValue(value, [], (pathSegments, currentValue) => {
    const lastSegment = pathSegments.at(-1);
    if (typeof currentValue !== "string" || !lastSegment) {
      return;
    }

    const joinedPath = pathSegments.join(".");
    const isSecretishField = looksLikeSecretFieldName(lastSegment);
    const isSecretHeaderValue =
      pathSegments.length >= 2 &&
      pathSegments[pathSegments.length - 2] === "headers" &&
      looksLikeSecretFieldName(lastSegment);

    if (!isSecretishField && !isSecretHeaderValue) {
      return;
    }

    if (
      currentValue.startsWith("{{") ||
      currentValue.startsWith("$ENV:") ||
      currentValue === ""
    ) {
      return;
    }

    diagnostics.push({
      level: "error",
      code: "SECRET_LITERAL",
      message: `Tracked ${kind} file contains a likely secret literal at ${joinedPath}. Use {{secrets.*}} or $ENV:NAME instead.`,
      filePath,
      path: joinedPath,
    });
  });

  return diagnostics;
}

function visitValue(
  value: unknown,
  pathSegments: string[],
  visitor: (pathSegments: string[], value: unknown) => void,
): void {
  visitor(pathSegments, value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitValue(entry, [...pathSegments, String(index)], visitor);
    });
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const [key, entry] of Object.entries(record)) {
    visitValue(entry, [...pathSegments, key], visitor);
  }
}
